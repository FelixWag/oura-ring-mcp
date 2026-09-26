/**
 * Repository for `telegram_bot_messages`: what the bot told the user.
 *
 * A reply binds to the bot message it answers, so every message the bot
 * sends about a meal is recorded with that meal. Only the first estimate used
 * to be remembered, so a reply to "Updated:" or "Removed" matched nothing.
 */

import type { Db } from '../index.js';

export type BotMessageKind =
  | 'estimate'
  | 'amended'
  | 'removed'
  | 'mismatch'
  | 'ambiguous'
  | 'failed'
  | 'reply';

/**
 * A reply to these acts on their meal: they PRESENT it. Not 'mismatch' or
 * 'failed' — "no" in reply to "that doesn't seem to be about X" must not
 * remove X. A new kind binds to nothing until it is added here on purpose.
 */
export const PRESENTS_MEAL = ['estimate', 'amended'] as const satisfies readonly BotMessageKind[];

/** These name a meal well enough to explain why a reply cannot act on it. */
export const IDENTIFIES_MEAL = [
  ...PRESENTS_MEAL,
  'removed',
] as const satisfies readonly BotMessageKind[];

export interface NewBotMessage {
  bot_id: number;
  chat_id: number;
  message_id: number;
  kind: BotMessageKind;
  meal_id?: number | null;
  answers_update_id?: number | null;
  model_call_id?: number | null;
  text: string;
}

export class BotMessagesRepo {
  constructor(private readonly db: Db) {}

  /** Record a sent message. A second record of the same message is ignored. */
  record(message: NewBotMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO telegram_bot_messages
           (bot_id, chat_id, message_id, kind, meal_id, answers_update_id, model_call_id,
            text, sent_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.bot_id,
        message.chat_id,
        message.message_id,
        message.kind,
        message.meal_id ?? null,
        message.answers_update_id ?? null,
        message.model_call_id ?? null,
        message.text,
        Math.floor(Date.now() / 1000),
      );
  }
}
