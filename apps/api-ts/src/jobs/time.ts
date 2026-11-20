/** Format like Laravel's toJSON(): UTC with six fractional digits. */
export function toLaravelJson(d: Date | null): string | null {
  if (d === null) return null;
  return d.toISOString().replace(/Z$/, '000Z');
}
