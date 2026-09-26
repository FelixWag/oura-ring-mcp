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
