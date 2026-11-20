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

  it('defaults LOG_LEVEL to info and accepts pino names', () => {
    expect(loadConfig({}).logLevel).toBe('info');
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
      expect(loadConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
    }
  });

  it.each([
    ['notice', 'info'],
    ['warning', 'warn'],
    ['critical', 'fatal'],
    ['alert', 'fatal'],
    ['emergency', 'fatal'],
    ['WARNING', 'warn'],
  ])('maps Laravel LOG_LEVEL %s to pino %s', (laravel, pino) => {
    expect(loadConfig({ LOG_LEVEL: laravel }).logLevel).toBe(pino);
  });

  it('rejects an unknown LOG_LEVEL with a clear message', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/Invalid LOG_LEVEL loud; use one of/);
  });

  it('throws when a numeric value is not an integer', () => {
    expect(() => loadConfig({ IMAGE_QUALITY: 'abc' })).toThrow();
  });
});
