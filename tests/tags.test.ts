import { describe, expect, it } from 'vitest';
import { shapeEnhancedTag } from '../src/oura/tags.js';

describe('shapeEnhancedTag', () => {
  it('extracts every supported field', () => {
    const out = shapeEnhancedTag({
      id: 'oura_x',
      tag_type_code: 'alcohol',
      custom_name: null,
      start_time: '2026-05-02T22:00:00+00:00',
      end_time: null,
      start_day: '2026-05-02',
      end_day: null,
      comment: '2 beers',
    });
    expect(out).toEqual({
      id: 'oura_x',
      tag_type_code: 'alcohol',
      custom_name: null,
      start_time: '2026-05-02T22:00:00+00:00',
      end_time: null,
      start_day: '2026-05-02',
      end_day: null,
      comment: '2 beers',
    });
  });

  it('coerces missing optional fields to null and missing required to empty string', () => {
    const out = shapeEnhancedTag({ id: 'x' });
    expect(out.id).toBe('x');
    expect(out.start_time).toBe('');
    expect(out.start_day).toBe('');
    expect(out.tag_type_code).toBeNull();
    expect(out.comment).toBeNull();
  });

  it('handles a custom-typed tag', () => {
    const out = shapeEnhancedTag({
      id: 'y',
      tag_type_code: 'custom',
      custom_name: 'jet_lag',
      start_time: '2026-05-12T10:00:00Z',
      start_day: '2026-05-12',
    });
    expect(out.tag_type_code).toBe('custom');
    expect(out.custom_name).toBe('jet_lag');
  });
});
