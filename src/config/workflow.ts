/**
 * `WORKFLOW.md` discovery, splitting and YAML front-matter parsing
 * (SPEC section 5.1, 5.2).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { WorkflowDefinition } from '../domain/types.js';
import { WorkflowError, describeError } from '../domain/errors.js';

/** Default workflow file name resolved against the process working directory. */
export const DEFAULT_WORKFLOW_FILE = 'WORKFLOW.md';

/**
 * Resolve the workflow path: an explicit runtime setting wins, otherwise the
 * cwd default `WORKFLOW.md` (SPEC 5.1).
 */
export function resolveWorkflowPath(explicit: string | undefined, cwd = process.cwd()): string {
  if (explicit !== undefined && explicit.trim() !== '') {
    return isAbsolute(explicit) ? resolve(explicit) : resolve(cwd, explicit);
  }
  return resolve(cwd, DEFAULT_WORKFLOW_FILE);
}

/**
 * Split a workflow document into YAML front matter and prompt body.
 *
 * Front matter exists only when the very first line is `---`; parsing stops at
 * the next line that is exactly `---`. The remainder is the prompt body, which
 * is trimmed before use.
 */
export function splitWorkflowDocument(text: string): { frontMatter: string | null; body: string } {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trimEnd() !== '---') {
    return { frontMatter: null, body: normalized.trim() };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() === '---') {
      return {
        frontMatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n').trim(),
      };
    }
  }
  // An opening fence with no closing fence is a malformed document, not a
  // body that happens to start with `---`.
  throw new WorkflowError('workflow_parse_error', 'workflow front matter is not terminated by a closing `---` line');
}

/** Parse workflow text into a definition. Throws {@link WorkflowError}. */
export function parseWorkflow(text: string, source = 'WORKFLOW.md'): WorkflowDefinition {
  let split: { frontMatter: string | null; body: string };
  try {
    split = splitWorkflowDocument(text);
  } catch (error) {
    throw error instanceof WorkflowError
      ? error
      : new WorkflowError('workflow_parse_error', describeError(error), { source });
  }

  if (split.frontMatter === null) {
    return { config: {}, prompt_template: split.body };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontMatter, { merge: true });
  } catch (error) {
    throw new WorkflowError('workflow_parse_error', `invalid YAML front matter: ${describeError(error)}`, {
      source,
    });
  }

  // An empty front-matter block decodes to null and is treated as an empty
  // config map; any other non-map value is a configuration error.
  if (parsed === null || parsed === undefined) {
    return { config: {}, prompt_template: split.body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkflowError(
      'workflow_front_matter_not_a_map',
      `workflow front matter must decode to a mapping, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
      { source },
    );
  }

  return { config: parsed as Record<string, unknown>, prompt_template: split.body };
}

/** Read and parse a workflow file. Throws {@link WorkflowError}. */
export async function loadWorkflowFile(path: string): Promise<WorkflowDefinition> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new WorkflowError('missing_workflow_file', `workflow file not found: ${path}`, { path });
    }
    throw new WorkflowError('missing_workflow_file', `cannot read workflow file ${path}: ${describeError(error)}`, {
      path,
    });
  }
  return parseWorkflow(text, path);
}
