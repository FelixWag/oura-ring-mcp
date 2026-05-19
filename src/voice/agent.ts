/**
 * Headless agent wrapper around the Claude Agent SDK.
 *
 * Spawns a fresh Claude session per voice log:
 *   - System prompt from `buildSystemPrompt`
 *   - MCP transport: a child process running this project's MCP server
 *     (dist/index.js), giving the agent access to `oura_add_annotation`
 *     and the read-only `oura_get_*` tools.
 *   - canUseTool allowlist: deny everything except the MCP oura tools.
 *     No Bash, no Edit, no Read, no nothing.
 *
 * Authentication: the SDK reads the user's Claude Code credentials from
 * `~/.claude/` — no ANTHROPIC_API_KEY required. Invocations count against
 * the user's existing subscription.
 *
 * Returns the count + summary of annotations created. Linkage between
 * the voice_log row and the created annotations is done by the caller
 * via a time-window UPDATE (cheaper than parsing every tool result).
 */

import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Db } from '../db/index.js';
import { buildSystemPrompt, type PromptContext } from './prompts.js';

export interface RunAgentInput {
  text: string;
  captured_at: string;
  user_timezone: string;
  /** Absolute path to the compiled MCP entry (typically dist/index.js). */
  mcpEntryPath: string;
  /** Optional model override. Defaults to Claude Code's current default. */
  model?: string;
}

export interface RunAgentResult {
  ok: boolean;
  error?: string;
  /** Number of oura_add_annotation tool uses we observed. */
  annotation_count: number;
  /** Short human-readable summary, suitable for the Siri banner. */
  summary: string;
  /** Window during which annotations were created — used to FK them back. */
  started_at: string;
  finished_at: string;
}

/**
 * Per-tool-name prefix the SDK applies to MCP-server tools when surfacing
 * them to Claude. Server name is `oura` (we choose it below). So
 * `oura_add_annotation` becomes `mcp__oura__oura_add_annotation`.
 */
const MCP_PREFIX = 'mcp__oura__';
const ALLOWED_MCP_TOOLS = new Set<string>([
  `${MCP_PREFIX}oura_add_annotation`,
  // Read-only tools — let Claude look up context if it wants. Cannot
  // modify anything.
  `${MCP_PREFIX}oura_get_personal_info`,
  `${MCP_PREFIX}oura_get_daily_summary`,
  `${MCP_PREFIX}oura_get_recent_summary`,
  `${MCP_PREFIX}oura_list_annotations`,
  `${MCP_PREFIX}oura_get_enhanced_tags`,
]);

const canUseTool = async (
  toolName: string,
  _input: Record<string, unknown>,
): Promise<PermissionResult> => {
  if (ALLOWED_MCP_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: _input };
  }
  return {
    behavior: 'deny',
    message:
      `Tool ${toolName} is not allowed in voice extraction. ` +
      `Only ${[...ALLOWED_MCP_TOOLS].join(', ')} are permitted.`,
  };
};

/**
 * Run the headless extraction agent. Caller is responsible for then
 * UPDATE-ing annotations.voice_log_id for rows created during
 * [started_at, finished_at].
 *
 * The `db` argument is currently unused but threaded through so future
 * versions can do in-process linking without a follow-up query.
 */
export async function runExtractionAgent(_db: Db, input: RunAgentInput): Promise<RunAgentResult> {
  const promptCtx: PromptContext = {
    captured_at: input.captured_at,
    user_timezone: input.user_timezone,
  };
  const systemPrompt = buildSystemPrompt(promptCtx);

  const started_at = new Date().toISOString();
  let annotation_count = 0;
  const annotationsSeen: { tag_type_code: unknown; comment: unknown }[] = [];

  try {
    const iterator = query({
      prompt: input.text,
      options: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
        // Spawn this project's MCP server so we get oura_* tools.
        mcpServers: {
          oura: {
            type: 'stdio',
            command: 'node',
            args: [input.mcpEntryPath],
            env: { ...process.env } as Record<string, string>,
          },
        },
        // Hard-deny everything except the MCP oura tools (read + write
        // to annotations). No Bash, no Read, no Edit, no Web, nothing.
        canUseTool,
        ...(input.model ? { model: input.model } : {}),
      },
    });

    for await (const message of iterator) {
      // Capture each oura_add_annotation tool_use so we know what got logged.
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && block.name === `${MCP_PREFIX}oura_add_annotation`) {
            const inp = (block.input ?? {}) as Record<string, unknown>;
            annotationsSeen.push({
              tag_type_code: inp.tag_type_code ?? null,
              comment: inp.comment ?? null,
            });
            annotation_count += 1;
          }
        }
      }
      if (message.type === 'result') {
        // Final result message. Loop will end after this.
        if (message.subtype !== 'success') {
          return {
            ok: false,
            error:
              ('result' in message && typeof message.result === 'string'
                ? message.result
                : `agent ended with subtype=${message.subtype}`) ?? 'unknown agent error',
            annotation_count,
            summary: shortSummary(annotationsSeen),
            started_at,
            finished_at: new Date().toISOString(),
          };
        }
      }
    }

    return {
      ok: true,
      annotation_count,
      summary: shortSummary(annotationsSeen),
      started_at,
      finished_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      annotation_count,
      summary: shortSummary(annotationsSeen),
      started_at,
      finished_at: new Date().toISOString(),
    };
  }
}

/**
 * Build a short summary string for the Siri banner. Example:
 *   "Logged 3: tag_sleep_alcohol, tag_generic_caffeine, tag_generic_workout"
 */
function shortSummary(entries: { tag_type_code: unknown; comment: unknown }[]): string {
  if (entries.length === 0) return 'No health-relevant items extracted.';
  const codes = entries
    .map((e) => (typeof e.tag_type_code === 'string' ? e.tag_type_code : 'custom'))
    .slice(0, 5);
  const more = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
  return `Logged ${entries.length}: ${codes.join(', ')}${more}`;
}
