/**
 * Minimal Telegram Bot API client — plain `fetch`, no dependency.
 *
 * Only the four calls this server needs. A library would bring a webhook
 * server, an update dispatcher and a plugin system we deliberately don't
 * want: long polling means no inbound port, which is the whole security
 * posture of this process.
 */

const API_BASE = 'https://api.telegram.org';

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean };
  media_group_id?: string;

  // Third-party content wearing the owner's envelope. A forwarded message has
  // the owner's chat.id and from.id, but its TEXT was written by someone else
  // — so these fields are the difference between "the owner said this" and
  // "the owner passed on what a stranger said". Declared here so they are
  // visible at review time rather than travelling invisibly inside `raw`.
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_sender_name?: string;
  via_bot?: unknown;
  reply_to_message?: TelegramMessage;
  quote?: unknown;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; file_unique_id: string; duration: number; file_size?: number };
  document?: {
    file_id: string;
    file_unique_id: string;
    mime_type?: string;
    file_name?: string;
    file_size?: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

export class TelegramClient {
  constructor(private readonly botToken: string) {}

  /**
   * The token is a credential, so it must never reach a log line or an error
   * message. Errors carry the method name, never the URL.
   */
  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) {
      throw new TelegramApiError(method, res.status, json.description ?? 'unknown error');
    }
    return json.result as T;
  }

  /**
   * Long poll. `offset` acknowledges every update below it — Telegram then
   * discards them permanently — so callers must not advance it before the
   * batch is committed.
   */
  async getUpdates(offset: number, timeoutSeconds = 30): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'edited_message'],
    });
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text });
  }

  /**
   * Resolve a file id to a download path. The path is guaranteed for only
   * about an hour, so resolve immediately before downloading rather than
   * storing it.
   */
  async getFilePath(fileId: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramApiError('getFile', 200, 'no file_path in response');
    return file.file_path;
  }

  fileUrl(filePath: string): string {
    return `${API_BASE}/file/bot${this.botToken}/${filePath}`;
  }

  /**
   * Remove any webhook. A webhook set on this bot makes `getUpdates` return
   * 409 forever, which looks exactly like "no messages".
   */
  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }
}

/** Bots may download files up to 20 MB. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
