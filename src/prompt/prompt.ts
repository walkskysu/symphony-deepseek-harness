/**
 * Prompt construction (SPEC section 12).
 *
 * The workflow body is rendered with strict semantics for the first turn.
 * Continuation turns send guidance to the existing thread instead of resending
 * the task prompt, because the full prompt is already in thread history
 * (SPEC 7.1, 10.2).
 */
import type { Issue } from '../domain/types.js';
import { renderTemplate } from '../config/template.js';
import type { ToolSpec } from '../tracker/adapter.js';

export const DEFAULT_PROMPT = 'You are working on an issue from the configured tracker.';

export interface PromptContext {
  issue: Issue;
  attempt: number | null;
  turn: number;
  max_turns: number;
}

/** Build the template input object: normalized issue fields plus `attempt`. */
export function buildTemplateInput(issue: Issue, attempt: number | null): Record<string, unknown> {
  return {
    issue: {
      id: issue.id,
      native_ref: issue.native_ref,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      branch_name: issue.branch_name,
      url: issue.url,
      assignee_id: issue.assignee_id,
      labels: issue.labels,
      blocked_by: issue.blocked_by,
      dispatchable: issue.dispatchable,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    attempt,
  };
}

/** Render the first-turn prompt; an empty body falls back to the default. */
export function renderIssuePrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
  toolsHint: string | null,
): string {
  const base = template.trim() === '' ? `${DEFAULT_PROMPT}\n\nIssue: ${issue.identifier}: ${issue.title}` : renderTemplate(template, buildTemplateInput(issue, attempt));
  return toolsHint === null ? base : `${base.trimEnd()}\n\n${toolsHint.trim()}\n`;
}

/** Build a continuation-turn prompt for the same thread. */
export function renderContinuationPrompt(
  custom: string | null,
  context: PromptContext,
  toolsHint: string | null,
): string {
  const base = custom !== null && custom.trim() !== ''
    ? renderTemplate(custom, {
        issue: buildTemplateInput(context.issue, context.attempt).issue,
        attempt: context.attempt,
        turn: context.turn,
        max_turns: context.max_turns,
      })
    : [
        `Continue working on ${context.issue.identifier}: ${context.issue.title} (turn ${context.turn} of ${context.max_turns}).`,
        '',
        'This is a continuation turn on the same thread: the original task prompt is already above.',
        `The issue is still in an active state ("${context.issue.state}"). Re-read the issue if needed, finish the remaining work, and update the ticket through the available tracker tools before you stop.`,
      ].join('\n');
  return toolsHint === null ? base : `${base.trimEnd()}\n\n${toolsHint.trim()}\n`;
}

/** Render the auto-generated tool hint block advertised to the agent. */
export function renderToolsHint(tools: ToolSpec[], shimPath: string | null): string | null {
  if (tools.length === 0 || shimPath === null) return null;
  const lines: string[] = [
    '## Tracker tools',
    '',
    'The tracker credential is managed by Symphony; you must use these host-side tools for tracker changes.',
    'Run them from the workspace with the Node.js shim below (arguments are JSON):',
    '',
    '```',
    `node "${shimPath}" <tool> '<json-arguments>'`,
    '```',
    '',
    'Available tools:',
  ];
  for (const tool of tools) {
    const required = Array.isArray(tool.input_schema['required']) ? (tool.input_schema['required'] as string[]) : [];
    const properties = typeof tool.input_schema['properties'] === 'object' && tool.input_schema['properties'] !== null
      ? Object.keys(tool.input_schema['properties'] as Record<string, unknown>)
      : [];
    const signature = properties
      .map((name) => (required.includes(name) ? `${name}` : `${name}?`))
      .join(', ');
    lines.push(`- \`${tool.name}\` (${signature})${tool.mutates ? ' [mutates tracker]' : ''}: ${tool.description}`);
  }
  lines.push('');
  lines.push('A tool result is JSON: `{"ok":true,"output":...}` on success, or `{"ok":false,"error":{...}}` on failure.');
  return lines.join('\n');
}
