/**
 * Meal extraction: a photo in, a structured estimate out.
 *
 * The model gets exactly one capability — reading the one image file the
 * server names — and no way to write anything. It returns JSON, the server
 * validates it and stores it.
 *
 * That is deliberately tighter than the insert-only tool allowlist the plan
 * called for. An allowlist limits what a hijacked agent can do; having no
 * write tool at all means a successful prompt injection has nothing to reach.
 * The agent is a function from an image to a JSON object, so it is given the
 * powers of one.
 */

import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { isolatedSessionOptions } from '../agent/session.js';
import type { MealEstimate } from '../db/repos/meals.js';
import {
  buildMealSystemPrompt,
  buildMealUserPrompt,
  buildCorrectionSystemPrompt,
  buildCorrectionUserPrompt,
  PROMPT_VERSION,
  CORRECTION_PROMPT_VERSION,
  type MealPromptContext,
} from './prompts.js';

export interface ExtractedItem {
  name: string;
  portion_text?: string | null;
  grams?: number | null;
  confidence?: number | null;
}

export interface ExtractedMeal {
  description: string;
  items: ExtractedItem[];
  totals: Record<string, number>;
  confidence: number | null;
  notes?: string | null;
  not_food?: boolean;
}

/** A photo extraction. */
export interface ExtractionResult extends Partial<CallMetrics> {
  ok: boolean;
  error?: string;
  meal?: ExtractedMeal;
  model: string;
  prompt_version: string;
  /** What the model said — kept on failure too, which is when it is needed. */
  raw_response?: string;
}

/**
 * A correction: exactly one of amended, mismatch or failed. A union rather
 * than optional fields, so a caller cannot report a mismatch as a failure by
 * checking in the wrong order, or drop an empty-reason mismatch with a truthy
 * test.
 */
export type CorrectionOutcome = Partial<CallMetrics> & {
  model: string;
  prompt_version: string;
  /** What the model said — kept on failure too, which is when it is needed. */
  raw_response?: string;
} & (
    | { kind: 'amended'; meal: ExtractedMeal }
    | { kind: 'mismatch'; reason: string }
    | { kind: 'failed'; error: string }
  );

/** Injected in tests so the suite never calls a model. */
export type QueryRunner = (args: {
  systemPrompt: string;
  userPrompt: string;
  /** Empty for a text-only correction of a meal with no stored photo. */
  photoPath: string;
  model: string;
}) => Promise<string | RunnerOutput>;

/** What a runner returns: the answer, plus usage when the real SDK reports it. */
export interface RunnerOutput {
  text: string;
  usage?: unknown;
  cost_usd?: number;
}

/** What every model call reports for its `model_calls` row. */
export interface CallMetrics {
  usage?: unknown;
  cost_usd?: number;
  duration_ms: number;
}

async function timedRun(
  runner: QueryRunner,
  args: Parameters<QueryRunner>[0],
): Promise<{ text: string } & CallMetrics> {
  const t0 = Date.now();
  const out = await runner(args);
  const { text, usage, cost_usd } = typeof out === 'string' ? { text: out } : out;
  return {
    text,
    duration_ms: Date.now() - t0,
    ...(usage !== undefined ? { usage } : {}),
    ...(cost_usd !== undefined ? { cost_usd } : {}),
  };
}

/**
 * Pinned: sessions load no settings (src/agent/session.ts), so anything left
 * unset falls to the SDK's bundled default, which moves on `npm update`.
 * `medium` is what these sessions ran at before v0.12.1.
 */
export const DEFAULT_MODEL = 'claude-opus-5';
export const EFFORT = 'medium';

/**
 * Parse the model's reply.
 *
 * Tolerant about packaging — a stray fence or a sentence before the JSON is a
 * formatting slip, not a reason to lose a meal — and strict about content,
 * which is checked separately against plausibility bounds before storage.
 */
export function parseExtraction(text: string): ExtractedMeal {
  const parsed = jsonObjectIn(text) as Partial<ExtractedMeal>;

  if (parsed.not_food === true) {
    return { description: '', items: [], totals: {}, confidence: null, not_food: true };
  }

  if (!parsed.totals || typeof parsed.totals !== 'object') {
    throw new Error('model response has no totals');
  }

  // Coerce rather than trust: a model may answer "640" as a string.
  const totals: Record<string, number> = {};
  for (const [nutrient, raw] of Object.entries(parsed.totals)) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) totals[nutrient] = value;
  }

  return {
    description: typeof parsed.description === 'string' ? parsed.description : '',
    items: Array.isArray(parsed.items) ? parsed.items.map(checkedItem) : [],
    totals,
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : null,
    notes: typeof parsed.notes === 'string' ? parsed.notes : null,
  };
}

/**
 * One item, checked field by field. Not trusted as it arrives: an item with no
 * string name failed the database write (NOT NULL) and was retried every poll
 * cycle, each retry a paid call, until the day's cap was gone. A malformed
 * item fails the estimate here instead, visibly and once.
 */
function checkedItem(raw: unknown): ExtractedItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  const name = typeof item['name'] === 'string' ? item['name'].trim() : '';
  if (!name) throw new Error('an item in the estimate has no name');
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const confidence = number(item['confidence']);
  return {
    name,
    portion_text: typeof item['portion_text'] === 'string' ? item['portion_text'] : null,
    grams: number(item['grams']),
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
  };
}

/** The one JSON object in a reply, tolerating a fence or prose around it. */
function jsonObjectIn(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  // Fall back to the outermost braces if the model wrapped the object in prose.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object in model response');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    // Not the parser's message: it quotes the input, and this error is logged.
    throw new Error('model response is not valid JSON');
  }
}

export type ParsedCorrection =
  | { kind: 'amended'; meal: ExtractedMeal }
  | { kind: 'mismatch'; reason: string };

/**
 * Parse a correction reply: an amended estimate, or "this does not fit".
 *
 * Stricter than a photo. A correction replaces numbers that are already
 * counted, so an answer that parses but says nothing usable — `not_food`,
 * empty totals, no energy — must fail rather than re-project the meal as
 * zeros.
 */
export function parseCorrection(text: string): ParsedCorrection {
  const parsed = jsonObjectIn(text);

  if (parsed['mismatch'] === true) {
    // Model text shown in chat: one line and bounded, so it cannot pose as a
    // separate message or run on (it can be steered by text inside a photo).
    const reason =
      typeof parsed['reason'] === 'string' ? parsed['reason'].replace(/\s+/g, ' ').trim() : '';
    return { kind: 'mismatch', reason: reason.slice(0, 300) };
  }
  if (parsed['not_food'] === true) {
    throw new Error('a correction answered "not food"');
  }

  const meal = parseExtraction(text);
  if (meal.totals['dietary_energy_consumed'] === undefined) {
    throw new Error('amended estimate has no energy total');
  }
  return { kind: 'amended', meal };
}

/**
 * Run the agent against one photo.
 *
 * `Read` is allowed only for the exact path the server chose. The path never
 * comes from message text, so a caption cannot redirect it, and the allowlist
 * refuses any other file even if the model asks.
 */
export async function extractMeal(
  ctx: MealPromptContext,
  options: { model?: string; runner?: QueryRunner } = {},
): Promise<ExtractionResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const systemPrompt = buildMealSystemPrompt();
  const userPrompt = buildMealUserPrompt(ctx);

  let raw: string | undefined;
  let metrics: Partial<CallMetrics> = {};
  try {
    const out = await timedRun(options.runner ?? defaultRunner, {
      systemPrompt,
      userPrompt,
      photoPath: ctx.photoPath,
      model,
    });
    ({ text: raw, ...metrics } = out);
    const meal = parseExtraction(raw);
    return { ok: true, meal, model, prompt_version: PROMPT_VERSION, raw_response: raw, ...metrics };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      model,
      prompt_version: PROMPT_VERSION,
      ...(raw !== undefined ? { raw_response: raw } : {}),
      ...metrics,
    };
  }
}

/**
 * Amend an existing estimate. Same posture as extraction — one readable file,
 * no write tools — with the whole previous estimate supplied (description,
 * items, totals, confidence) so the model corrects rather than starts over,
 * and can tell when a correction is about a different meal.
 */
export async function correctMeal(
  ctx: MealPromptContext & { previous: MealEstimate },
  options: { model?: string; runner?: QueryRunner } = {},
): Promise<CorrectionOutcome> {
  const model = options.model ?? DEFAULT_MODEL;
  const systemPrompt = buildCorrectionSystemPrompt();
  const userPrompt = buildCorrectionUserPrompt({
    ...ctx,
    previous: JSON.stringify(ctx.previous, null, 2),
  });
  const base = { model, prompt_version: CORRECTION_PROMPT_VERSION };

  let raw: string | undefined;
  let metrics: Partial<CallMetrics> = {};
  try {
    const out = await timedRun(options.runner ?? defaultRunner, {
      systemPrompt,
      userPrompt,
      photoPath: ctx.photoPath,
      model,
    });
    ({ text: raw, ...metrics } = out);
    return { ...base, ...metrics, ...parseCorrection(raw), raw_response: raw };
  } catch (err) {
    return {
      ...base,
      ...metrics,
      kind: 'failed',
      error: (err as Error).message,
      ...(raw !== undefined ? { raw_response: raw } : {}),
    };
  }
}

/** An error this file wrote, so its message is known to carry no model text. */
class ModelCallError extends Error {}

/** The real agent call. Isolated so tests can replace it wholesale. */
const defaultRunner: QueryRunner = async ({ systemPrompt, userPrompt, photoPath, model }) => {
  // Read, and only for this one file. `tools` removes every other built-in
  // from the session; `canUseTool` narrows Read to the photo. That check only
  // holds because the cwd is empty and the photo lives outside it: reads
  // inside the cwd would be approved without consulting it.
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (toolName === 'Read' && input['file_path'] === photoPath) {
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: `Only reading ${photoPath} is permitted during meal extraction.`,
    };
  };

  const iterator = query({
    prompt: userPrompt,
    options: {
      // No photo (a text-only correction): nothing to read, so no Read tool.
      tools: photoPath ? ['Read'] : [],
      model,
      effort: EFFORT,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      canUseTool,
      // Last: nothing above may override isolation.
      ...isolatedSessionOptions(),
    },
  });

  let answer = '';
  let usage: unknown;
  let cost_usd: number | undefined;
  try {
    for await (const message of iterator) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') answer += block.text;
        }
      }
      if (message.type === 'result') {
        usage = message.usage;
        cost_usd = message.total_cost_usd;
        // The subtype, not `result`: this error is logged, and whether the SDK
        // puts model text into `result` on failure is not something to rely on.
        if (message.subtype !== 'success' || message.is_error) {
          throw new ModelCallError(`model call ended: ${message.subtype}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof ModelCallError) throw err;
    // The SDK's own errors can quote the result text ("Claude Code returned an
    // error result: …"), and this message is logged. Keep only what kind of
    // error it was.
    throw new ModelCallError(`model call failed (${(err as Error).name})`);
  }

  if (!answer.trim()) throw new Error('model returned no text');
  return { text: answer, usage, ...(cost_usd !== undefined ? { cost_usd } : {}) };
};
