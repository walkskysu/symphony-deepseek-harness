/**
 * Child-process environment construction (SPEC 15.3).
 *
 * Tracker credentials resolved from the environment are removed before the
 * coding agent is launched, so a child can never read the raw token from its
 * environment. Only the attempt-scoped tool-bridge variables are added.
 */

/** Remove a set of variable names, case-insensitively (Windows envs are). */
export function stripEnvNames(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const blocked = new Set(names.map((name) => name.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (blocked.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Build the environment handed to a coding-agent subprocess. */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  secretNames: string[],
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const base = stripEnvNames(parent, [
    ...secretNames,
    // The attempt-scoped tool credential and its pointing metadata are rebuilt
    // for every run, so inherited leftovers are dropped first. The grant is
    // deliberately not named *TOKEN: DSH scrubs TOKEN/SECRET/KEY/PASSWORD names
    // from the agent's own child processes.
    'SYMPHONY_TOOL_GRANT',
    'SYMPHONY_TOOL_TOKEN',
    'SYMPHONY_TOOL_URL',
    'SYMPHONY_TOOL_SHIM',
  ]);
  return { ...base, ...extra };
}
