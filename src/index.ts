/**
 * Public programmatic entry point.
 *
 * The CLI in `bin.ts` is a thin wrapper over {@link SymphonyService}, so the
 * daemon can also be embedded in tests or another host process.
 */
export { SymphonyService } from './service.js';
export type { SymphonyServiceOptions } from './service.js';
export { Orchestrator } from './orchestrator/orchestrator.js';
export type { OrchestratorOptions, ServiceSnapshot } from './orchestrator/orchestrator.js';
export { WorkspaceManager, deriveWorkspaceKey } from './workspace/manager.js';
export { loadWorkflowFile, parseWorkflow, splitWorkflowDocument, resolveWorkflowPath } from './config/workflow.js';
export { resolveConfig } from './config/config.js';
export { parseEnvFile, loadEnvFile, mergeEnv, resolveEnvironment } from './config/env-file.js';
export type { ParsedEnvFile, EnvResolution } from './config/env-file.js';
export type { ServiceConfig } from './config/config.js';
export { Template, parseTemplate, renderTemplate } from './config/template.js';
export { createTrackerAdapter, adapterStateDefaults, SUPPORTED_TRACKER_KINDS } from './tracker/registry.js';
export type { TrackerAdapter, ToolSpec, ToolResult, ToolContext, AdapterProfile } from './tracker/adapter.js';
export { createAgentBackend } from './agent/factory.js';
export type { AgentBackend, AgentSession, AgentTurnResult } from './agent/backend.js';
export type { AgentEvent, TokenUsage } from './agent/events.js';
export { createLogger, StructuredLogger, NullLogger } from './observability/logger.js';
export type { Logger } from './observability/logger.js';
export type { RuntimeSnapshot, IssueDetail } from './observability/snapshot.js';
export { startHttpServer } from './server/http.js';
export { ToolBridge } from './tools/bridge.js';
export { sortForDispatch, compareForDispatch, isActiveState, isTerminalState, isRoutable } from './orchestrator/eligibility.js';
export type { Issue, WorkflowDefinition, RetryEntry, LiveSession } from './domain/types.js';
export { WorkflowError, ValidationError } from './domain/errors.js';
