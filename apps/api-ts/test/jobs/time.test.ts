import { describe, expect, it } from 'vitest';
import { toLaravelJson } from '../../src/jobs/time.js';

describe('toLaravelJson', () => {
  it('formats like Laravel toJSON', () => {
    expect(toLaravelJson(new Date('2026-11-20T10:00:00Z'))).toBe('2026-11-20T10:00:00.000000Z');
  });

  it('passes null through', () => {
    expect(toLaravelJson(null)).toBeNull();
  });
});
