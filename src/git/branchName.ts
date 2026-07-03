/**
 * Composes the final feature branch name from the team's configured
 * `branchPattern` (see config/loader.ts) and the values captured/passed at
 * run time, so naming conventions like "bugfix/PROJ-123/fix-login" are a
 * config choice instead of hardcoded.
 */

export interface BranchNameVars {
  type: string;
  name: string;
  ticket?: string;
}

const PLACEHOLDER = /\{(type|ticket|name)\}/g;
// A git ref segment: no leading dash/dot, safe punctuation only. Slashes are
// allowed since patterns like "{type}/{ticket}/{name}" use them as separators.
const SAFE_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Throws when `pattern` references {ticket} but no ticket was supplied —
 * a missing ticket id would otherwise silently collapse into a double slash
 * or trailing separator instead of surfacing the misconfiguration.
 */
export function buildBranchName(pattern: string, vars: BranchNameVars): string {
  if (pattern.includes('{ticket}') && !vars.ticket) {
    throw new Error(
      `branchPattern "${pattern}" requires a ticket id — pass one with --ticket <id>, or drop {ticket} from branchPattern.`,
    );
  }

  const branchName = pattern.replace(PLACEHOLDER, (_match, key: 'type' | 'ticket' | 'name') => vars[key] ?? '');

  if (!SAFE_BRANCH_NAME.test(branchName)) {
    throw new Error(`composed branch name "${branchName}" (from branchPattern "${pattern}") is not a valid git branch name`);
  }
  return branchName;
}
