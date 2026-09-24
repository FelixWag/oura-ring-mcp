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
import { isolatedSessionOptions } from '../agent/sandbox.js';
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

export interface ExtractionResult {
  ok: boolean;
  error?: string;
  meal?: ExtractedMeal;
  model: string;
  prompt_version: string;
  raw_response?: string;
}

/** Injected in tests so the suite never calls a model. */
export type QueryRunner = (args: {
  systemPrompt: string;
  userPrompt: string;
  photoPath: string;
  model?: string;
}) => Promise<string>;

export const DEFAULT_MODEL = 'claude-opus-5';
/**
 * Pinned at what the session inherited from the operator's settings before
 * isolation. Unpinned, an isolated session sends no effort at all and the
 * model's default applies — a cost and latency change nobody chose.
 */
export const EFFORT = 'medium';

/**
 * Parse the model's reply.
 *
 * Tolerant about packaging — a stray fence or a sentence before the JSON is a
 * formatting slip, not a reason to lose a meal — and strict about content,
 * which is checked separately against plausibility bounds before storage.
 */
export function parseExtraction(text: string): ExtractedMeal {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  // Fall back to the outermost braces if the model wrapped the object in prose.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object in model response');
  }

  const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<ExtractedMeal>;

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
    items: Array.isArray(parsed.items) ? parsed.items : [],
    totals,
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : null,
    notes: typeof parsed.notes === 'string' ? parsed.notes : null,
  };
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

  try {
    const runner = options.runner ?? defaultRunner;
    const raw = await runner({ systemPrompt, userPrompt, photoPath: ctx.photoPath, model });
    const meal = parseExtraction(raw);
    return { ok: true, meal, model, prompt_version: PROMPT_VERSION, raw_response: raw };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      model,
      prompt_version: PROMPT_VERSION,
    };
  }
}

/**
 * Amend an existing estimate. Same posture as extraction — one readable file,
 * no write tools — with the previous object supplied so the model corrects
 * rather than starts over.
 */
export async function correctMeal(
  ctx: MealPromptContext & { previous: Record<string, unknown> },
  options: { model?: string; runner?: QueryRunner } = {},
): Promise<ExtractionResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const systemPrompt = buildCorrectionSystemPrompt();
  const userPrompt = buildCorrectionUserPrompt({
    ...ctx,
    previous: JSON.stringify(ctx.previous, null, 2),
  });

  try {
    const runner = options.runner ?? defaultRunner;
    const raw = await runner({ systemPrompt, userPrompt, photoPath: ctx.photoPath, model });
    const meal = parseExtraction(raw);
    return {
      ok: true,
      meal,
      model,
      prompt_version: CORRECTION_PROMPT_VERSION,
      raw_response: raw,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      model,
      prompt_version: CORRECTION_PROMPT_VERSION,
    };
  }
}

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
      ...isolatedSessionOptions(),
      tools: ['Read'],
      effort: EFFORT,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      canUseTool,
      ...(model ? { model } : {}),
    },
  });

  let answer = '';
  for await (const message of iterator) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text') answer += block.text;
      }
    }
    if (message.type === 'result' && message.subtype !== 'success') {
      throw new Error(
        'result' in message && typeof message.result === 'string'
          ? message.result
          : 'extraction failed',
      );
    }
  }

  if (!answer.trim()) throw new Error('model returned no text');
  return answer;
};
