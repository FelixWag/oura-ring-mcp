/**
 * CRUD repository for the `annotations` table.
 *
 * Schema mirrors Oura's EnhancedTagModel (see DECISIONS.md, "Local annotation
 * schema mirrors Oura's EnhancedTagModel"). All inputs validated; all SQL
 * via prepared statements with bound parameters — never string interpolation.
 */

import type { Db } from './index.js';
import { acceptedTagTypeCodes, isKnownTagTypeCode } from './tag_types.js';

export type AnnotationSource = 'local' | 'oura';

export interface Annotation {
  id: number;
  tag_type_code: string | null;
  custom_name: string | null;
  start_time: string;
  end_time: string | null;
  start_day: string;
  end_day: string | null;
  comment: string | null;
  source: AnnotationSource;
  oura_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewAnnotationInput {
  tag_type_code: string | null;
  custom_name?: string | null;
  start_time: string;
  end_time?: string | null;
  start_day: string;
  end_day?: string | null;
  comment?: string | null;
  /** Default 'local'. */
  source?: AnnotationSource;
  /** Required when source='oura'; ignored otherwise. */
  oura_id?: string | null;
}

export interface UpdateAnnotationInput {
  tag_type_code?: string | null;
  custom_name?: string | null;
  start_time?: string;
  end_time?: string | null;
  start_day?: string;
  end_day?: string | null;
  comment?: string | null;
}

export interface ListAnnotationsFilter {
  /** YYYY-MM-DD; matches rows whose annotation span overlaps this date or later. */
  start_date?: string;
  /** YYYY-MM-DD; matches rows whose annotation span overlaps this date or earlier. */
  end_date?: string;
  tag_type_code?: string;
  source?: AnnotationSource;
}

export class AnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationValidationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CUSTOM_NAME_RE = /^[\p{L}\p{N} _\-/&]{1,60}$/u;

function nowIso(): string {
  return new Date().toISOString();
}

function isIsoDateTime(v: string): boolean {
  return !Number.isNaN(Date.parse(v));
}

/**
 * Predicate used to check whether a `tag_type_code` is accepted. Defaults to
 * the static `KNOWN_TAG_TYPE_CODES` shortlist. v0.4 wires in a wider check
 * that also accepts codes seen in synced Oura data (`discovered_tag_types`).
 */
export type CodeKnownPredicate = (code: string) => boolean;

function validateInput(input: NewAnnotationInput, isCodeKnown: CodeKnownPredicate): void {
  if (!DATE_RE.test(input.start_day)) {
    throw new AnnotationValidationError('start_day must be YYYY-MM-DD.');
  }
  if (input.end_day != null && !DATE_RE.test(input.end_day)) {
    throw new AnnotationValidationError('end_day must be YYYY-MM-DD or null.');
  }
  if (input.end_day != null && input.end_day < input.start_day) {
    throw new AnnotationValidationError('end_day cannot be before start_day.');
  }
  if (!isIsoDateTime(input.start_time)) {
    throw new AnnotationValidationError('start_time must be an ISO 8601 datetime.');
  }
  if (input.end_time != null && !isIsoDateTime(input.end_time)) {
    throw new AnnotationValidationError('end_time must be an ISO 8601 datetime or null.');
  }
  if (input.end_time != null && Date.parse(input.end_time) < Date.parse(input.start_time)) {
    throw new AnnotationValidationError('end_time cannot be before start_time.');
  }

  // Mirror Oura's enum semantics: code must be null, 'custom', or known
  // (either in the static list or in the user's synced Oura data).
  if (input.tag_type_code != null) {
    if (input.tag_type_code !== 'custom' && !isCodeKnown(input.tag_type_code)) {
      const accepted = acceptedTagTypeCodes().join(', ');
      throw new AnnotationValidationError(
        `Unknown tag_type_code "${input.tag_type_code}". Accepted: ${accepted}, or any code ` +
          'observed in your synced Oura data (run `npm run sync`), or null. ' +
          'Use tag_type_code="custom" with a custom_name for ad-hoc types.',
      );
    }
  }

  if (input.tag_type_code === 'custom') {
    if (!input.custom_name || !CUSTOM_NAME_RE.test(input.custom_name)) {
      throw new AnnotationValidationError(
        'custom_name is required when tag_type_code="custom" (1–60 chars, letters/digits/space/_-/&).',
      );
    }
  } else if (input.custom_name) {
    throw new AnnotationValidationError('custom_name is only allowed when tag_type_code="custom".');
  }

  // At least one of (tag_type_code, comment) must be present — otherwise the row
  // carries no information. Matches the table's CHECK constraint.
  if (input.tag_type_code == null && (!input.comment || input.comment.trim() === '')) {
    throw new AnnotationValidationError(
      'A text-only annotation (tag_type_code=null) requires a non-empty comment.',
    );
  }

  if (input.source === 'oura' && !input.oura_id) {
    throw new AnnotationValidationError('oura_id is required when source="oura".');
  }
}

export class AnnotationRepo {
  constructor(private readonly db: Db) {}

  /**
   * A code is "known" if it's in the static KNOWN_TAG_TYPE_CODES list OR
   * has been observed in synced Oura data (`discovered_tag_types` table).
   * Cheap: an indexed point lookup. Falls back to false if the v0.4 table
   * doesn't exist yet (migration not yet applied).
   */
  private isCodeKnown = (code: string): boolean => {
    if (isKnownTagTypeCode(code)) return true;
    try {
      const row = this.db
        .prepare<
          unknown[],
          { code: string }
        >('SELECT code FROM discovered_tag_types WHERE code = ?')
        .get(code);
      return !!row;
    } catch {
      // discovered_tag_types not yet present (e.g. running on a pre-v0.4 DB).
      return false;
    }
  };

  add(input: NewAnnotationInput): Annotation {
    validateInput(input, this.isCodeKnown);
    const now = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO annotations
        (tag_type_code, custom_name, start_time, end_time, start_day, end_day,
         comment, source, oura_id, created_at, updated_at)
      VALUES
        (@tag_type_code, @custom_name, @start_time, @end_time, @start_day, @end_day,
         @comment, @source, @oura_id, @created_at, @updated_at)
    `);
    const info = stmt.run({
      tag_type_code: input.tag_type_code,
      custom_name: input.custom_name ?? null,
      start_time: input.start_time,
      end_time: input.end_time ?? null,
      start_day: input.start_day,
      end_day: input.end_day ?? null,
      comment: input.comment ?? null,
      source: input.source ?? 'local',
      oura_id: input.oura_id ?? null,
      created_at: now,
      updated_at: now,
    });
    const row = this.get(Number(info.lastInsertRowid));
    if (!row) throw new Error('Insert succeeded but row not found — should be unreachable.');
    return row;
  }

  get(id: number): Annotation | null {
    const row = this.db
      .prepare<unknown[], Annotation>('SELECT * FROM annotations WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  list(filter: ListAnnotationsFilter = {}): Annotation[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.start_date !== undefined) {
      if (!DATE_RE.test(filter.start_date)) {
        throw new AnnotationValidationError('start_date must be YYYY-MM-DD.');
      }
      where.push('COALESCE(end_day, start_day) >= @start_date');
      params.start_date = filter.start_date;
    }
    if (filter.end_date !== undefined) {
      if (!DATE_RE.test(filter.end_date)) {
        throw new AnnotationValidationError('end_date must be YYYY-MM-DD.');
      }
      where.push('start_day <= @end_date');
      params.end_date = filter.end_date;
    }
    if (filter.tag_type_code !== undefined) {
      where.push('tag_type_code = @tag_type_code');
      params.tag_type_code = filter.tag_type_code;
    }
    if (filter.source !== undefined) {
      where.push('source = @source');
      params.source = filter.source;
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM annotations ${whereClause} ORDER BY start_day ASC, id ASC`;
    return this.db.prepare<unknown[], Annotation>(sql).all(params) as Annotation[];
  }

  update(id: number, patch: UpdateAnnotationInput): Annotation | null {
    const existing = this.get(id);
    if (!existing) return null;
    // Build a merged input and re-validate so partial updates can't leave the
    // row in a state that would have failed at insert time.
    const merged: NewAnnotationInput = {
      tag_type_code:
        'tag_type_code' in patch ? (patch.tag_type_code ?? null) : existing.tag_type_code,
      custom_name: 'custom_name' in patch ? (patch.custom_name ?? null) : existing.custom_name,
      start_time: patch.start_time ?? existing.start_time,
      end_time: 'end_time' in patch ? (patch.end_time ?? null) : existing.end_time,
      start_day: patch.start_day ?? existing.start_day,
      end_day: 'end_day' in patch ? (patch.end_day ?? null) : existing.end_day,
      comment: 'comment' in patch ? (patch.comment ?? null) : existing.comment,
      source: existing.source,
      oura_id: existing.oura_id,
    };
    validateInput(merged, this.isCodeKnown);

    const stmt = this.db.prepare(`
      UPDATE annotations SET
        tag_type_code = @tag_type_code,
        custom_name   = @custom_name,
        start_time    = @start_time,
        end_time      = @end_time,
        start_day     = @start_day,
        end_day       = @end_day,
        comment       = @comment,
        updated_at    = @updated_at
      WHERE id = @id
    `);
    stmt.run({
      ...merged,
      updated_at: nowIso(),
      id,
    });
    return this.get(id);
  }

  delete(id: number): boolean {
    const info = this.db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
