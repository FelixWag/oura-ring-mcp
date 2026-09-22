/**
 * Telegram inbound: filtering, classification, offset arithmetic.
 *
 * Every fixture is synthetic. A real update embeds a name and chat id, and
 * this repo is public.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/index.js';
import { TelegramUpdatesRepo } from '../src/db/repos/telegram_updates.ts';
import {
  classifyMessage,
  isAllowed,
  processBatch,
  type ClassifiedMessage,
} from '../src/telegram/server.ts';
import { normalizeExtension } from '../src/telegram/media.ts';
import type { TelegramConfig } from '../src/config.ts';
import type { TelegramMessage, TelegramUpdate } from '../src/telegram/client.ts';

const CONFIG: TelegramConfig = {
  botToken: '123456789:test-secret-never-real',
  botId: 123456789,
  allowedChatId: 555000111,
  mediaDir: '/tmp/telegram-media-test',
  tz: 'Europe/Vienna',
  logPath: '/tmp/never-written-telegram.log',
};

let db: Db;
let repo: TelegramUpdatesRepo;

beforeEach(async () => {
  db = await openDatabase(':memory:');
  repo = new TelegramUpdatesRepo(db);
});

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 900,
    date: 1_767_225_000,
    chat: { id: CONFIG.allowedChatId, type: 'private' },
    from: { id: CONFIG.allowedChatId, is_bot: false },
    text: 'chicken bowl',
    ...overrides,
  };
}

function update(update_id: number, overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  return { update_id, message: message(overrides) };
}

describe('chat filtering', () => {
  it('accepts the allowed private chat', () => {
    expect(isAllowed(update(1), CONFIG.allowedChatId)).toBe(true);
  });

  it('rejects another chat', () => {
    // A bot token is discoverable and anyone can message a bot.
    const stranger = { update_id: 2, message: message({ chat: { id: 999, type: 'private' } }) };
    expect(isAllowed(stranger, CONFIG.allowedChatId)).toBe(false);
  });

  it('rejects a group chat even with the right id', () => {
    // Otherwise every member of the group could write to a health database.
    const group = {
      update_id: 3,
      message: message({ chat: { id: CONFIG.allowedChatId, type: 'group' } }),
    };
    expect(isAllowed(group, CONFIG.allowedChatId)).toBe(false);
  });

  it('rejects a different sender in the allowed chat', () => {
    const impostor = { update_id: 4, message: message({ from: { id: 777, is_bot: false } }) };
    expect(isAllowed(impostor, CONFIG.allowedChatId)).toBe(false);
  });
});

describe('the poll offset', () => {
  it('starts at zero with no history', () => {
    expect(repo.nextOffset(CONFIG.botId)).toBe(0);
  });

  it('advances past a rejected update so the queue cannot livelock', () => {
    // THE BUG THIS PINS: rejected updates are never inserted, so they cannot
    // raise MAX(update_id). Without the high-water mark the next poll asks
    // for the same rejected update forever, and one message from a stranger
    // pins the queue until a legitimate one arrives with a higher id.
    const stranger = { update_id: 42, message: message({ chat: { id: 999, type: 'private' } }) };

    const result = processBatch([stranger], repo, CONFIG);

    expect(result).toMatchObject({ accepted: 0, rejected: 1 });
    expect(repo.countAll()).toBe(0); // nothing stored about a third party
    expect(repo.nextOffset(CONFIG.botId)).toBe(43); // but the offset moved
  });

  it('takes the highest id whether it was accepted or rejected', () => {
    processBatch(
      [update(10), { update_id: 11, message: message({ chat: { id: 999, type: 'private' } }) }],
      repo,
      CONFIG,
    );

    expect(repo.nextOffset(CONFIG.botId)).toBe(12);
  });

  it('never moves the high-water mark backwards', () => {
    processBatch(
      [{ update_id: 50, message: message({ chat: { id: 999, type: 'private' } }) }],
      repo,
      CONFIG,
    );
    processBatch(
      [{ update_id: 20, message: message({ chat: { id: 999, type: 'private' } }) }],
      repo,
      CONFIG,
    );

    expect(repo.nextOffset(CONFIG.botId)).toBe(51);
  });

  it('is scoped per bot, because update_id restarts for a new token', () => {
    processBatch([update(100)], repo, CONFIG);

    expect(repo.nextOffset(CONFIG.botId)).toBe(101);
    expect(repo.nextOffset(987654321)).toBe(0);
  });

  it('treats a redelivered update as a no-op', () => {
    // A crash between Telegram's response and our commit means the same batch
    // arrives again. It must not double-store.
    processBatch([update(7)], repo, CONFIG);
    const second = processBatch([update(7)], repo, CONFIG);

    expect(second).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(repo.countAll()).toBe(1);
  });
});

describe('classification', () => {
  const photo = (sizes: Array<[number, number]>): ClassifiedMessage =>
    classifyMessage(
      message({
        text: undefined,
        caption: 'lunch',
        photo: sizes.map(([width, height], i) => ({
          file_id: `f${i}`,
          file_unique_id: `u${i}`,
          width,
          height,
        })),
      }),
    );

  it('takes the largest photo size, and records which one', () => {
    // Which size was downloaded decides whether a later calorie estimate came
    // from the full image or a thumbnail.
    const result = photo([
      [90, 90],
      [1280, 960],
      [320, 240],
    ]);

    expect(result.kind).toBe('photo');
    expect(result.photo_width).toBe(1280);
    expect(result.file_id).toBe('f1');
    expect(result.text).toBe('lunch');
  });

  it('classifies a photo sent at full size as a document, not a dropped message', () => {
    // iOS "send as file" arrives as a document. Silently losing these would
    // lose exactly the high-quality meal photos this system wants.
    const result = classifyMessage(
      message({
        text: undefined,
        document: { file_id: 'd1', file_unique_id: 'du1', mime_type: 'image/jpeg' },
      }),
    );

    expect(result.kind).toBe('document');
    expect(result.file_id).toBe('d1');
  });

  it('keeps an unhandled kind rather than dropping it', () => {
    const result = classifyMessage(message({ text: undefined }));

    expect(result.kind).toBe('other');
  });
});

describe('edits', () => {
  it('keeps both versions and marks the older superseded', () => {
    // An edit arrives as a NEW update_id with the SAME message_id. Replacing
    // in place loses the audit trail; ignoring the link double-counts a
    // corrected meal.
    processBatch([update(1, { text: 'chicken bowl' })], repo, CONFIG);
    processBatch(
      [
        {
          update_id: 2,
          edited_message: message({ text: 'chicken bowl, large', edit_date: 1_767_225_600 }),
        },
      ],
      repo,
      CONFIG,
    );

    const rows = db
      .prepare('SELECT text, superseded_by FROM telegram_updates ORDER BY update_id')
      .all() as Array<{ text: string; superseded_by: number | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.text).toBe('chicken bowl');
    expect(rows[0]?.superseded_by).not.toBeNull();
    expect(rows[1]?.superseded_by).toBeNull();
  });
});

describe('stored rows', () => {
  it('marks a media message pending and a text message stored', () => {
    // Media cannot be fetched inside the insert transaction, so 'pending'
    // names the gap between the row committing and the file arriving.
    processBatch(
      [
        update(1),
        {
          update_id: 2,
          message: message({
            message_id: 901,
            text: undefined,
            photo: [{ file_id: 'f', file_unique_id: 'u', width: 800, height: 600 }],
          }),
        },
      ],
      repo,
      CONFIG,
    );

    const rows = db
      .prepare('SELECT kind, status FROM telegram_updates ORDER BY update_id')
      .all() as Array<{ kind: string; status: string }>;

    expect(rows[0]).toMatchObject({ kind: 'text', status: 'stored' });
    expect(rows[1]).toMatchObject({ kind: 'photo', status: 'pending' });
  });

  it('records the assumed timezone rather than implying the sender sent one', () => {
    processBatch([update(1)], repo, CONFIG);

    const row = db.prepare('SELECT tz_assumed FROM telegram_updates').get() as {
      tz_assumed: string;
    };
    expect(row.tz_assumed).toBe('Europe/Vienna');
  });

  it("stores Telegram's instant, not our receipt clock", () => {
    processBatch([update(1)], repo, CONFIG);

    const row = db.prepare('SELECT sent_epoch FROM telegram_updates').get() as {
      sent_epoch: number;
    };
    expect(row.sent_epoch).toBe(1_767_225_000);
  });

  it('gives up on a download after repeated failures instead of retrying forever', () => {
    processBatch(
      [
        {
          update_id: 1,
          message: message({
            text: undefined,
            photo: [{ file_id: 'f', file_unique_id: 'u', width: 800, height: 600 }],
          }),
        },
      ],
      repo,
      CONFIG,
    );
    const row = repo.pendingMedia()[0]!;

    for (let i = 0; i < 5; i += 1) repo.markFailed(row.id, 'network down', 5);

    const after = db.prepare('SELECT status, attempts FROM telegram_updates').get() as {
      status: string;
      attempts: number;
    };
    expect(after.status).toBe('dead');
    expect(repo.pendingMedia()).toHaveLength(0);
  });
});

describe('media filenames', () => {
  it('allows known extensions and rejects anything else', () => {
    // The remote side controls the path this is derived from, so an unknown
    // extension must not be trusted into a filename.
    expect(normalizeExtension('photos/file_12.jpg')).toBe('.jpg');
    expect(normalizeExtension('voice/note.OGA')).toBe('.oga');
    expect(normalizeExtension('evil/payload.sh')).toBe('.bin');
    expect(normalizeExtension('no-extension')).toBe('.bin');
  });
});
