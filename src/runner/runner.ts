/**
 * One worker attempt: workspace, prompt, agent session, in-worker turn loop
 * (SPEC 16.5, 10.7).
 */
import type { FailureKind, Issue, LiveSession, RunAttemptPhase, WorkerOutcome } from '../domain/types.js';
import type { ServiceConfig } from '../config/config.js';
import type { TrackerAdapter } from '../tracker/adapter.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { AgentBackend, AgentSession } from '../agent/backend.js';
import type { AgentEvent } from '../agent/events.js';
import { buildChildEnv } from '../agent/env.js';
import type { ToolBridge } from '../tools/bridge.js';
import type { Logger } from '../observability/logger.js';
import { describeError } from '../domain/errors.js';
import { isActiveState, isRoutable } from '../orchestrator/eligibility.js';
import { renderContinuationPrompt, renderIssuePrompt, renderToolsHint } from '../prompt/prompt.js';

export interface AttemptCallbacks {
  onPhase(phase: RunAttemptPhase): void;
  onWorkspace(path: string): void;
  onTurnStart(turn: number, maxTurns: number): void;
  onAgentEvent(event: AgentEvent): void;
  onSessionUpdate(update: Partial<LiveSession>): void;
  onIssueRefreshed(issue: Issue): void;
  onLog(message: string, context?: Record<string, unknown>): void;
}

export interface RunnerDeps {
  config: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  workspace: WorkspaceManager;
  backend: AgentBackend;
  logger: Logger;
  bridge: ToolBridge | null;
  parentEnv: NodeJS.ProcessEnv;
}

export interface AttemptResult {
  outcome: WorkerOutcome;
  workspace_path: string | null;
  turns: number;
  final_text: string | null;
}

class AttemptFailure extends Error {
  readonly category: FailureKind;

  constructor(category: FailureKind, message: string) {
    super(message);
    this.name = 'AttemptFailure';
    this.category = category;
  }
}

/** Run one worker attempt to completion and report a structured outcome. */
export class AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(issue: Issue, attempt: number | null, signal: AbortSignal, callbacks: AttemptCallbacks): Promise<AttemptResult> {
    const config = this.deps.config;
    let workspacePath: string | null = null;
    let session: AgentSession | null = null;
    let turns = 0;
    let finalText: string | null = null;
    let credential: { token: string } | null = null;
    let outcome: WorkerOutcome;

    try {
      callbacks.onPhase('PreparingWorkspace');
      const workspace = await this.deps.workspace.ensure(issue.identifier).catch((error: unknown) => {
        throw new AttemptFailure('workspace_error', `workspace preparation failed: ${describeError(error)}`);
      });
      workspacePath = workspace.path;
      callbacks.onWorkspace(workspace.path);

      // Validate the launch contract before starting anything (SPEC 9.5, 15.2).
      if (workspace.path !== this.deps.workspace.pathFor(issue.identifier).path) {
        throw new AttemptFailure('invalid_workspace_cwd', `workspace cwd does not match the issue workspace: ${workspace.path}`);
      }

      const beforeRunError = await this.deps.workspace.beforeRun(workspace.path, issue.identifier).then(
        () => null,
        (error: unknown) => describeError(error),
      );
      if (beforeRunError !== null) {
        throw new AttemptFailure('hook_error', beforeRunError);
      }

      const secretNames = this.deps.tracker.secretEnvironmentNames?.() ?? [];
      const bridgeCredential = this.deps.bridge?.enabled === true ? this.deps.bridge.createRun(issue) : null;
      credential = bridgeCredential;
      const env = buildChildEnv(this.deps.parentEnv, secretNames, bridgeCredential?.env ?? {});
      const toolsHint = config.tools.enabled && config.tools.prompt_hint
        ? renderToolsHint(this.deps.bridge?.tools ?? [], this.deps.bridge?.shim ?? null)
        : null;

      callbacks.onPhase('LaunchingAgentProcess');
      try {
        session = await this.deps.backend.startSession({
          workspacePath: workspace.path,
          issue,
          attempt,
          env,
          signal,
        });
      } catch (error) {
        throw new AttemptFailure('response_error', `agent session startup failed: ${describeError(error)}`);
      }
      callbacks.onPhase('InitializingSession');
      callbacks.onSessionUpdate({
        thread_id: session.threadId,
        codex_app_server_pid: session.pid,
      });

      const maxTurns = config.agent.max_turns;
      let currentIssue = issue;
      const title = this.deps.backend.sessionTitle(currentIssue);

      for (;;) {
        callbacks.onPhase('BuildingPrompt');
        let prompt: string;
        try {
          prompt = turns === 0
            ? renderIssuePrompt(this.deps.promptTemplate, currentIssue, attempt, toolsHint)
            : renderContinuationPrompt(config.harness.continuation_prompt, {
                issue: currentIssue,
                attempt,
                turn: turns + 1,
                max_turns: maxTurns,
              }, toolsHint);
        } catch (error) {
          throw new AttemptFailure('prompt_error', `prompt rendering failed: ${describeError(error)}`);
        }

        turns += 1;
        callbacks.onTurnStart(turns, maxTurns);
        callbacks.onPhase('StreamingTurn');
        const turnResult = await session.runTurn({
          prompt,
          title,
          onEvent: (event) => callbacks.onAgentEvent(event),
          signal,
        });
        finalText = turnResult.final_text ?? finalText;

        if (!turnResult.ok) {
          const error = turnResult.error ?? { category: 'worker_error' as const, message: 'agent turn failed' };
          throw new AttemptFailure(error.category, error.message);
        }
        if (turnResult.session_id !== null) {
          callbacks.onSessionUpdate({ session_id: turnResult.session_id });
        }

        // Re-check the tracker between turns (SPEC 7.1).
        const refreshed = await this.deps.tracker.fetchIssuesByIds([currentIssue.id]);
        if (!refreshed.ok) {
          throw new AttemptFailure(
            'tracker_error',
            `issue state refresh failed: ${refreshed.error.category}: ${refreshed.error.message}`,
          );
        }
        if (refreshed.value.length === 0) {
          callbacks.onLog('issue no longer visible after turn; ending worker', { turn: turns });
          break;
        }
        const next = refreshed.value[0] as Issue;
        currentIssue = next;
        callbacks.onIssueRefreshed(next);

        if (!isActiveState(next, config) || !isRoutable(next, config)) break;
        if (turns >= maxTurns) {
          callbacks.onLog('max_turns reached; ending worker', { turn: turns, max_turns: maxTurns });
          break;
        }
      }

      callbacks.onPhase('Finishing');
      outcome = { kind: 'normal' };
    } catch (error) {
      if (signal.aborted) {
        outcome = { kind: 'canceled', reason: 'run canceled' };
      } else if (error instanceof AttemptFailure) {
        outcome = { kind: 'failed', error: error.message, reason: error.category };
      } else {
        outcome = { kind: 'failed', error: describeError(error), reason: 'worker_error' };
      }
    } finally {
      if (session !== null) {
        try {
          await session.stop();
        } catch (error) {
          callbacks.onLog('stopping the agent session failed', { error: describeError(error) });
        }
      }
      if (workspacePath !== null) {
        await this.deps.workspace.afterRun(workspacePath, issue.identifier);
      }
      if (credential !== null) this.deps.bridge?.releaseRun(credential.token);
    }

    return { outcome, workspace_path: workspacePath, turns, final_text: finalText };
  }
}

export { AttemptFailure };
