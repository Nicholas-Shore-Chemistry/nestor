// Shared fixture helpers for the usage-gate and spawn-guard tests. Every date is relative to `now`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const iso = (ms) => new Date(ms).toISOString();

/**
 * Writes ctx-meter snapshot files into `d`. Each entry: { five, week, reset, updated } or { rate_limits, updated }.
 */
export function writeSnaps(d, snaps, now = Date.now()) {
  fs.mkdirSync(d, { recursive: true });
  snaps.forEach((s, i) => {
    const rl = s.rate_limits ?? {
      five_hour: { used_percentage: s.five, resets_at: iso(s.reset ?? now + 3 * 3600_000) },
      seven_day: { used_percentage: s.week ?? 40, resets_at: iso(s.weekReset ?? now + 3 * 86400_000) },
    };
    fs.writeFileSync(
      path.join(d, `snapshot-s${i}.json`),
      JSON.stringify({ updated_at: iso(s.updated ?? now - 30_000), rate_limits: rl }),
    );
  });
  return d;
}

/** A temp Claude config dir with optional ctx-meter snapshots and an optional nestor/config.json text. */
export function cfgDir(snaps, configText) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ucfg-'));
  if (snaps) writeSnaps(path.join(base, 'ctx-meter'), snaps, Date.now());
  if (configText !== undefined) {
    fs.mkdirSync(path.join(base, 'nestor'));
    fs.writeFileSync(path.join(base, 'nestor', 'config.json'), configText);
  }
  return base;
}
