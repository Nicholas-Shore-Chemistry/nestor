// Turn arithmetic of the waits in core.md §1.1 and §4 at the shipped defaults.
// A wake-up is a full context read, so each one counts as one turn of the waiting agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validateConfig } from '../plugins/nestor/scripts/lib/nestor-config.mjs';

/**
 * Controller waiting for a reply that arrives after `replyMin` minutes, with a background timer of
 * `timerMin` minutes pending (core §1.1). Every timer that fires first is one turn (start the next timer),
 * the reply is one more. A timer due in the same minute as the reply is stopped in the reply turn.
 */
export function replyWaitTurns(replyMin, timerMin) {
  let turns = 0;
  for (let t = timerMin; t < replyMin; t += timerMin) turns++;
  return turns + 1;
}

/**
 * Controller on WAIT with keep-warm (core §4): the gate wait runs in chunks of `chunkMin`; each chunk that ends
 * without GO is one controller turn (send KEEPWARM, start the next chunk) and one turn for the OK that comes back.
 * The chunk that ends on GO is one turn. Returns controller turns and keep-warm turns of the sub-orchestrator.
 */
export function keepWarmTurns(goMin, chunkMin) {
  let controller = 0;
  let sub = 0;
  for (let t = chunkMin; t < goMin; t += chunkMin) {
    controller += 2;
    sub += 1;
  }
  return { controller: controller + 1, sub };
}

test('2 h wait for a reply at the default timer costs at most 3 controller turns', () => {
  assert.ok(replyWaitTurns(120, DEFAULTS.gate.timerMin) <= 3, `${replyWaitTurns(120, DEFAULTS.gate.timerMin)} turns`);
  assert.equal(replyWaitTurns(120, DEFAULTS.gate.timerMin), 3);
  assert.equal(replyWaitTurns(120, 10), 12, 'the old default woke eleven times for nothing');
});

test('every wait up to 2 h stays within 3 turns', () => {
  for (let m = 1; m <= 120; m++) assert.ok(replyWaitTurns(m, DEFAULTS.gate.timerMin) <= 3, `${m} min`);
});

test('default timer fires inside the cache window and passes validation', () => {
  assert.ok(DEFAULTS.gate.timerMin <= DEFAULTS.cache.warmWindowMin);
  assert.ok(DEFAULTS.gate.timerMin < 60);
  assert.deepEqual(validateConfig({}), { errors: [], warnings: [] });
});

test('keep-warm ships off, and a wait at keepWarmMaxMin costs few tiny sub-orchestrator turns', () => {
  assert.equal(DEFAULTS.cache.keepWarm, false);
  const r = keepWarmTurns(DEFAULTS.cache.keepWarmMaxMin, DEFAULTS.cache.warmWindowMin);
  assert.deepEqual(r, { controller: 7, sub: 3 });
  // Cost model of the review: a keep-warm turn reads 0.1 of the context, a cold restart writes it at 1.25 or more.
  assert.ok(r.sub * 0.1 < 1.25);
});
