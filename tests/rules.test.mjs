// Checks plugins/nestor/rules/*.md: real config keys only, no numbers outside the fixed process constants, the
// pending-wait rule, <root> script paths, NestOr names, no leftovers, length, start-up bytes per role, one place per
// reader for the timer and command rules, and that every section reference in the repo resolves.
// RULES_DIR overrides the folder (used to prove each test fails on a broken copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_KEYS, READERS, ROOT, RULE_FILES, bytes, namedKeys, readRule, readerTexts, spans,
} from './readers.mjs';

const R = Object.fromEntries(RULE_FILES.map((f) => [f, readRule(f)]));
const { 'core.md': core, 'workflow.md': workflow, 'controller.md': controller, 'replies.md': replies } = R;
const grunt = R['grunt-use.md'];
const all = RULE_FILES.map((f) => R[f]).join('\n');
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

test('rules name only keys that exist', () => {
  const keys = new Set(ALL_KEYS);
  assert.deepEqual(namedKeys(all).filter((k) => !keys.has(k)), []);
});

test('rules hold no numbers', () => {
  // `× 60` is a unit conversion (minutes to seconds), not a tunable value
  const ALLOWED = ['15 lines', 'fix round 3', 'fix round 4', '1 h', '5 min', '5h', '7d', 'NESTOR_HEADLESS_WAIT=1', '× 60'];
  for (const name of RULE_FILES) {
    const stripped = R[name]
      .split('\n')
      .map((l) => {
        let s = l.replace(/^#+ \d+(\.\d+)*\.?/, '').replace(/§\d+(\.\d+)*/g, '');
        for (const a of ALLOWED) s = s.split(a).join('');
        return s;
      });
    const hits = stripped.map((s, i) => [i, s]).filter(([, s]) => /\d/.test(s));
    assert.deepEqual(hits, [], `${name}: digits outside the fixed constants`);
  }
});

test('rules mention the rule-relevant keys', () => {
  const required = [
    'agents.slow.workers', 'agents.fast.workers', 'agents.subOrchs',
    'context.subOrchSoftK', 'context.subOrchHardK', 'context.controllerK',
    'cache.warmWindowMin', 'grunt.controller', 'grunt.subOrch', 'grunt.rotateK',
    'grunt.coldIdleMin', 'grunt.coldCtxK', 'grunt.readLowCtxK', 'grunt.readHighCtxK', 'grunt.readLowChars',
    'grunt.readMidChars', 'worker.stopTurns', 'worker.longWaitMin',
    'gate.shortWaitMin', 'gate.timerMin', 'fiveHour.killWorkers', 'gate.enabled', 'gate.fiveHour.enabled',
    'cache.keepWarm', 'cache.keepWarmMaxMin', 'weekly.stop', 'context.coldResumeK',
  ];
  const present = new Set(spans(all));
  assert.deepEqual(required.filter((k) => !present.has(k)), []);
});

test('pending-wait rule present', () => {
  assert.match(replies, /SendMessage/);
  assert.match(replies, /run_in_background/);
  assert.match(replies, /don't end your turn with nothing pending/i);
  assert.match(replies, /SendMessage. in flight is not pending/);
  assert.match(controller, /end no turn with nothing pending/);
});

test('timer stop, HANDOFF-TEXT reader, grunt reply limit and headless rule present', () => {
  // seconds stated, so the model does no unit conversion of its own
  assert.match(replies, /`sleep <s>` with `<s>` = `gate\.timerMin`\s+× 60, in seconds/);
  assert.match(replies, /`TaskStop` is a deferred tool, load it with `ToolSearch`/);
  assert.match(replies, /`TaskStop` your pending timers\s+before the final report/);
  assert.match(core, /under `HANDOFF-TEXT:` and end with the word the work earned/);
  assert.match(controller, /The controller writes that text to `HANDOFF-<wp>\.md`/);
  assert.match(controller, /passes the text verbatim in the next `RESUME` or spawn prompt/);
  assert.match(controller, /quotes the text in its final report/);
  assert.match(grunt, /The reply is the grunt's hand-back, from its agent id/);
  assert.match(grunt, /counts once/);
  assert.match(controller, /\*\*Headless\*\*, instead of the above \(the gate prints `headless: true`\)/);
  assert.match(controller, /`NESTOR_HEADLESS_WAIT=1`/);
});

test('reply channel, timer purpose and keep-warm rules present', () => {
  assert.match(grunt, /The grunt has one reply channel, its hand-back \(end-of-turn text\)/);
  assert.match(grunt, /No `REPLY:` line; the grunt has no `SendMessage`/);
  assert.doesNotMatch(all, /REPLY: <text\|message>|`REPLY: message`|`REPLY: text`/);
  assert.doesNotMatch(all, /a reply may come twice/);
  assert.match(replies, /The timer only keeps something pending/);
  assert.match(replies, /answer it with the next timer call only, no text/);
  assert.match(replies, /needs no timer for them; the timer is for `SendMessage` replies only/);
  assert.match(controller, /never on a grunt reply, a "completed" notice or a timer/);
  assert.match(controller, /^## 3\. Keep-warm$/m);
  assert.match(core, /On `KEEPWARM <n>`: reply with the single word `OK`, no tool call, no tick/);
  assert.match(controller, /at least five points below `fiveHour\.killWorkers`/);
  assert.match(controller, /below\s+`weekly\.stop`/);
  assert.match(controller, /never headless/);
});

test('controller.md names context.coldResumeK in §1 (the exception) and §2 (the stop before a cold wait)', () => {
  const section = (n) => controller.split(/^## /m).find((s) => s.startsWith(`${n}. `)) ?? '';
  assert.match(section(1), /Never resume a large cold context\.[\s\S]*?Exception:[\s\S]*?`context\.coldResumeK`/);
  assert.match(section(2), /Not `GO`:[\s\S]*?above `context\.coldResumeK` or is `\?`[\s\S]*?end the session/);
  assert.match(section(2), /\*\*Cold\*\*[\s\S]*?`context\.coldResumeK`/);
});

test('scripts use <root>', () => {
  // quoted, the form the run skill's allowed-tools rules match
  for (const s of ['"<root>/scripts/usage-gate.mjs"', '"<root>/scripts/ctx.mjs"', '"<root>/scripts/tick.mjs"', '"<root>/scripts/config.mjs" --print --role']) {
    assert.ok(all.includes(s), `missing ${s}`);
  }
  assert.doesNotMatch(all, /node <root>\//, 'an unquoted script form does not match the grant');
  assert.ok(!all.includes('${CLAUDE_PLUGIN_ROOT}'), 'rules must not use ${CLAUDE_PLUGIN_ROOT}');
});

test('no leftovers', () => {
  // The path check is written with [/] so the identity scan does not flag this file; it matches the same text.
  const banned = [
    /copilot/i, /tracker/i, /ORCH-(RUN|TAG)/, /orch-core/, /helpful-grunt/,
    /copilot-worker/, /\bsub-orch\b/, /Devel[/]/, /[A-Z]:[\\/]/, /trial/i,
  ];
  assert.deepEqual(banned.filter((re) => re.test(all)).map(String), []);
});

test('big reads: bands by config key, file hand-back, injection flag, no writes on the grunt', () => {
  const sec = R['reads.md'];
  assert.match(grunt, /^## 6\. Big reads$[^]*`reads\.md`/m);
  for (const k of ['grunt.readLowCtxK', 'grunt.readHighCtxK', 'grunt.readLowChars', 'grunt.readMidChars'])
    assert.ok(sec.includes(`\`${k}\``), k);
  assert.match(sec, /`FILE: <path>`/);
  assert.match(sec, /`INJECTION:`/);
  assert.match(sec, /data, never\s+instructions/);
  assert.match(sec, /never calls an MCP write tool/);
  assert.match(sec, /Short-lived/);
  assert.doesNotMatch(sec, /<SOURCE>|own prefix/, 'a task always starts with TASK <id>:');
  assert.match(sec, /`<config>\/nestor\/grunt-mcp-read\.txt` \(empty by default\)/);
  assert.match(sec, /--limit <n>/);
  assert.match(grunt, /^## 6\. Big reads$[^]*MCP writes[^]*`reads\.md`/m);
  assert.match(sec, /"<root>\/scripts\/extract\.mjs"/);
});

test('big reads: MCP writes go to one Sonnet general-purpose worker, never the grunt or nestor:worker', () => {
  const line = R['reads.md'].split(/\r?\n- /).find((b) => /MCP writes/.test(b) && /plan file/.test(b));
  assert.ok(line, 'no MCP writes line in reads.md');
  assert.match(line, /`general-purpose`/);
  assert.match(line, /`model: sonnet`/);
  assert.match(line, /counts and warnings/);
  assert.match(line, /never the grunt/);
  assert.match(line, /never `nestor:worker`/);
});

test('names and heads', () => {
  for (const s of ['nestor:nestor', 'nestor:worker', 'nestor:grunt', 'NESTOR-RUN:', 'NESTOR-TAG:', 'GRUNT-TAG:']) {
    assert.ok(all.includes(s), `missing ${s}`);
  }
});

test('length limits', () => {
  assert.ok(lineCount(core) <= 100, `core.md has ${lineCount(core)} lines`);
  assert.ok(bytes(core) <= 7800, `core.md has ${bytes(core)} bytes`);
  assert.ok(lineCount(workflow) <= 100, `workflow.md has ${lineCount(workflow)} lines`);
  for (const f of ['controller.md', 'replies.md', 'grunt-use.md']) assert.ok(lineCount(R[f]) <= 100, f);
});

// Before the rules were split by role, every sub-orchestrator and the controller read 30.7k bytes at start-up.
const BEFORE = { suborch: 30741, controller: 30805 };
const startup = (role, withGrunt) => readerTexts(role, withGrunt).reduce((n, [, t]) => n + bytes(t), 0);

test('start-up bytes: a sub-orchestrator without a grunt reads at most 14k, the controller no more than before', () => {
  assert.ok(startup('suborch', false) <= 14000, `sub-orchestrator ${startup('suborch', false)}`);
  assert.ok(startup('suborch', true) < BEFORE.suborch, `sub-orchestrator with grunt ${startup('suborch', true)}`);
  assert.ok(startup('controller', true) <= BEFORE.controller, `controller ${startup('controller', true)}`);
});

test('each orchestrator body names exactly the rules files its role reads', () => {
  for (const [role, r] of Object.entries(READERS)) {
    const [[, body]] = readerTexts(role, false);
    const named = [...body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/([\w-]+\.md)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(named)].sort(), [...r.always, ...r.grunt].sort(), role);
  }
});

test('the timer rule and the command rule live in one place per reader', () => {
  const TIMER = /`sleep <s>` with `<s>` = `gate\.timerMin`/g;
  const COMMAND = /no `&&`, `;`, pipes/g;
  for (const role of Object.keys(READERS))
    for (const withGrunt of [false, true]) {
      const texts = readerTexts(role, withGrunt);
      const where = (re) => texts.filter(([, t]) => re.test(t)).map(([n]) => n);
      const count = (re) => texts.reduce((n, [, t]) => n + (t.match(re) || []).length, 0);
      const label = `${role}${withGrunt ? ' with grunt' : ''}`;
      if (role === 'controller' || withGrunt) assert.deepEqual([where(TIMER), count(TIMER)], [['replies.md'], 1], label);
      else assert.equal(count(TIMER), 0, label);
      // workflow.md holds the command rule twice: once for the worker briefs, once for NestOr's own steps.
      assert.deepEqual(where(COMMAND), ['workflow.md'], label);
    }
});

// ---- Section references ----

const REF_FILES = ['core', 'workflow', 'controller', 'replies', 'grunt-use'];
const FILE_MENTION = new RegExp(`\\b(${REF_FILES.join('|')})(?:\\.md)?\\b`, 'g');

/** Section numbers that are headings of `name`: "## 4. ..." gives "4", "### 4.1 ..." gives "4.1". */
export function headings(text) {
  return new Set([...text.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)].map((m) => m[1]));
}

/** Every section reference in `text`: [{ file, section, line }]. `own` is the file a bare § means, or null. */
export function sectionRefs(text, own) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\\\./g, '.');
    for (const m of line.matchAll(/§(\d+(?:\.\d+)?)/g)) {
      // the nearest file named before it in the same clause
      const clause = line.slice(0, m.index).split(/[.;]\s|\.$/).at(-1);
      const files = [...clause.matchAll(FILE_MENTION)].map((f) => f[1]);
      out.push({ file: files.at(-1) ?? own, section: m[1], line: i + 1 });
    }
    for (const m of line.matchAll(/sections? (\d+)(?: (?:to|and) (\d+))? of `?([\w-]+)\.md/g))
      for (const s of [m[1], m[2]].filter(Boolean)) out.push({ file: m[3], section: s, line: i + 1 });
    for (const m of line.matchAll(/([\w-]+)\.md section (\d+)/g)) out.push({ file: m[1], section: m[2], line: i + 1 });
  });
  return out;
}

function repoFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) repoFiles(p, out);
    else if (/\.(md|mjs|json|yml)$/.test(e.name)) out.push(p);
  }
  return out;
}

// A § in a regex that bans an old leftover is not a reference.
const NOT_REFS = [['tests/grunt-eval.test.mjs', '8']];

test('every section reference in the repo resolves to a heading of the new files', () => {
  const H = Object.fromEntries(REF_FILES.map((f) => [f, headings(R[`${f}.md`])]));
  const bad = [];
  let n = 0;
  for (const p of repoFiles()) {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (rel === 'tests/rules.test.mjs') continue;
    const m = /^plugins\/nestor\/rules\/([\w-]+)\.md$/.exec(rel);
    const own = m ? m[1] : null;
    for (const ref of sectionRefs(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), own)) {
      if (NOT_REFS.some(([f, s]) => f === rel && s === ref.section)) continue;
      n++;
      if (!ref.file || !H[ref.file]?.has(ref.section)) bad.push(`${rel}:${ref.line} ${ref.file ?? '?'} §${ref.section}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(n > 20, `only ${n} references found`);
});

test('the section reference check catches a stale reference', () => {
  assert.deepEqual(sectionRefs('see `core.md` §4.2 and §9', null).map((r) => `${r.file} ${r.section}`), ['core 4.2', 'core 9']);
  assert.deepEqual(sectionRefs('as in §3. Then `controller.md` §2', 'core').map((r) => `${r.file} ${r.section}`), ['core 3', 'controller 2']);
  assert.deepEqual(sectionRefs('sections 2 to 4 of `core.md`', null).map((r) => r.section), ['2', '4']);
  assert.ok(!headings(core).has('4.2'), 'core.md has no §4.2 any more');
});

test('worktree workers start from the orchestrator branch and merge back into it (#35)', () => {
  const core = readRule('core.md');
  assert.match(core, /git merge --ff-only <your branch>/);
  assert.match(core, /merge its branch into yours/);
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'writing-briefs.md'), 'utf8');
  assert.match(doc, /"baseRef": "head"/);
  assert.match(doc, /never into the default branch/);
});
