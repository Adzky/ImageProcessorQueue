import { describe, expect, it } from 'vitest';
import { SCHEDULE } from '../../src/maintenance/schedule.js';

describe('SCHEDULE', () => {
  it('reaps every minute', () => {
    expect(SCHEDULE.reap).toBe('* * * * *');
  });

  it('cleans up hourly', () => {
    expect(SCHEDULE.cleanup).toBe('0 * * * *');
  });
});
