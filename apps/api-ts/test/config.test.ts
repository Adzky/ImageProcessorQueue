import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns the documented defaults for an empty environment', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      maxUploadBytes: 20480 * 1024,
      maxDimension: 1280,
      quality: 80,
      maxPixels: 50_000_000,
      staleAfterSeconds: 600,
      lostAfterSeconds: 3600,
      retentionHours: 24,
      processingDelayMs: 0,
      runMigrations: false,
    });
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({ IMAGE_QUALITY: '55', RUN_MIGRATIONS: 'true' });

    expect(config.quality).toBe(55);
    expect(config.runMigrations).toBe(true);
  });

  it('throws when a numeric value is not an integer', () => {
    expect(() => loadConfig({ IMAGE_QUALITY: 'abc' })).toThrow();
  });
});
