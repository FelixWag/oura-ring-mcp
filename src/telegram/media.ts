/**
 * Downloading inbound media to disk.
 *
 * On disk rather than in SQLite: the database is already ~150 MB and gets
 * copied and backed up, nothing will ever query image bytes, and the
 * extractor that reads these files is an agent whose tools take a path.
 *
 * Every filename is derived from the content hash, never from the name the
 * remote side supplied — a remote-controlled filename is how a download
 * becomes an arbitrary file write.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_DOWNLOAD_BYTES } from './client.js';

export interface StoredMedia {
  /** Path RELATIVE to the media root, so the database isn't pinned to a machine. */
  relativePath: string;
  sha256: string;
  bytes: number;
}

export class MediaTooLargeError extends Error {
  constructor(size: number) {
    super(`media is ${size} bytes, over the ${MAX_DOWNLOAD_BYTES} byte limit`);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Fetch a file and write it under `mediaRoot`, 0600.
 *
 * `sentEpoch` only decides the directory, so files land in date order rather
 * than one flat directory that becomes unusable after a year.
 */
export async function downloadMedia(
  url: string,
  mediaRoot: string,
  sentEpoch: number,
  extension: string,
): Promise<StoredMedia> {
  const res = await fetch(url, {
    // Telegram's file endpoint does not redirect. Following one would let a
    // 3xx point this fetch at any host — including the voice and health
    // servers listening on localhost.
    redirect: 'error',
    // Without this a stalled response holds the whole poll loop until
    // undici's 300s body timeout, and no messages are processed meanwhile.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`download failed: HTTP ${res.status}`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    // Cancel rather than leaving a socket with an unread body.
    await res.body?.cancel();
    throw new MediaTooLargeError(declared);
  }

  // Streamed with a running count rather than buffered then checked: a
  // response with no content-length, or one that understates it, would
  // otherwise be fully in memory before any limit could be enforced.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error('download failed: empty response body');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new MediaTooLargeError(total);
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks, total);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const day = new Date(sentEpoch * 1000).toISOString().slice(0, 10).replace(/-/g, '/');
  // Content-addressed: the same photo sent twice writes the same bytes to the
  // same path, which is a no-op rather than a duplicate.
  const relativePath = join(day, `${sha256}${normalizeExtension(extension)}`);
  const absolutePath = join(mediaRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, buffer, { mode: 0o600 });

  return { relativePath, sha256, bytes: buffer.byteLength };
}

/**
 * Only an allowlisted extension, lowercased. The remote side controls the
 * file path we derive this from, so anything unexpected becomes `.bin`
 * rather than being trusted.
 */
export function normalizeExtension(raw: string): string {
  const ext = raw.toLowerCase().replace(/^.*\./, '');
  const allowed = new Set(['jpg', 'jpeg', 'png', 'heic', 'webp', 'oga', 'ogg', 'mp3', 'm4a']);
  return allowed.has(ext) ? `.${ext}` : '.bin';
}
