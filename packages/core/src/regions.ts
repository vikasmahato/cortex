import type { Region } from './types.ts';

const TEST_OR_BUILD =
  /\b(test|vitest|jest|pytest|mocha|lint|eslint|biome|tsc|typecheck|build|compile|cargo (check|test|build)|go (test|build|vet)|npm run (test|build|lint))\b/i;
const MEMORY_PATH = /[\\/](memory|\.claude)[\\/]|MEMORY\.md$/i;

/** Map a tool call to the brain region it should light up. */
export function regionForTool(
  tool: string | null | undefined,
  input?: unknown,
  isError = false,
): Region {
  if (isError) return 'amygdala';
  const name = tool ?? '';
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'Read': case 'Grep': case 'Glob': case 'NotebookRead': case 'LS':
      return 'occipital';
    case 'Edit': case 'Write': case 'NotebookEdit': case 'MultiEdit': {
      const p = String(i.file_path ?? '');
      return MEMORY_PATH.test(p) ? 'hippocampus' : 'motor';
    }
    case 'Bash': case 'PowerShell':
      return TEST_OR_BUILD.test(String(i.command ?? '')) ? 'cerebellum' : 'motor';
    case 'WebSearch': case 'WebFetch': case 'ToolSearch':
      return 'parietal';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'EnterPlanMode':
    case 'ExitPlanMode': case 'AskUserQuestion': case 'Agent': case 'Task':
      return 'prefrontal';
    case 'Skill':
      return 'hippocampus';
    default:
      return name.startsWith('mcp__') ? 'parietal' : 'motor';
  }
}

/** Map a Claude Code hook event name to a region (for non-tool hooks). */
export function regionForHook(hook: string): Region {
  switch (hook) {
    case 'UserPromptSubmit': return 'temporal';
    case 'Stop': case 'SessionEnd': case 'PreCompact': case 'SessionStart':
      return 'hippocampus';
    case 'Notification': return 'amygdala';
    default: return 'motor';
  }
}
