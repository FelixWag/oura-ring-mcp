/**
 * Compact projection for Oura's `enhanced_tag` endpoint.
 *
 * Mirrors the same column names we use in our local `annotations` table so a
 * future tool that returns "all annotations across local + Oura sources" can
 * present a uniform shape regardless of where each row came from.
 *
 * Raw access remains available via `verbose: true` on the tool.
 */

export interface CompactEnhancedTag {
  id: string;
  tag_type_code: string | null;
  custom_name: string | null;
  start_time: string;
  end_time: string | null;
  start_day: string;
  end_day: string | null;
  comment: string | null;
}

function getString(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

export function shapeEnhancedTag(row: unknown): CompactEnhancedTag {
  return {
    id: getString(row, 'id') ?? '',
    tag_type_code: getString(row, 'tag_type_code'),
    custom_name: getString(row, 'custom_name'),
    start_time: getString(row, 'start_time') ?? '',
    end_time: getString(row, 'end_time'),
    start_day: getString(row, 'start_day') ?? '',
    end_day: getString(row, 'end_day'),
    comment: getString(row, 'comment'),
  };
}
