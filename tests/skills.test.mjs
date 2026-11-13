import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkill, splitTools, assertNamedScriptsOnly } from './skill-helpers.mjs';

const run = loadSkill('run');

test('run skill is user-only', () => {
  assert.equal(run.front.name, 'run');
  assert.equal(run.front['disable-model-invocation'], 'true');
  assert.ok(run.front.description && run.front.description.length > 10);
});

test('run skill pre-approves only named scripts', () => {
  const bash = assertNamedScriptsOnly('run');
  assert.deepEqual(splitTools(run.front['allowed-tools']), [
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" *)',
    'Read(${CLAUDE_PLUGIN_ROOT}/rules/*)',
    'Edit(./orchestration/HANDOFF-*.md)',
    'Write(./orchestration/HANDOFF-*.md)',
    'Edit(./orchestration/STATUS.md)',
    'Write(./orchestration/STATUS.md)',
    'Edit(./orchestration/rules.md)',
    'Write(./orchestration/rules.md)',
  ]);
  assert.equal(bash.length, 4);
});

test('every file grant of every skill is scoped: the rules read, and orchestration/ writes for run only', () => {
  const allowed = 'Read(${CLAUDE_PLUGIN_ROOT}/rules/*)';
  for (const n of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    for (const t of splitTools(loadSkill(n).front['allowed-tools'])) {
      if (!/^(Read|Edit|Write|Glob|Grep|NotebookEdit)\b/.test(t)) continue;
      if (n === 'run' && ['Edit(./orchestration/HANDOFF-*.md)', 'Write(./orchestration/HANDOFF-*.md)', 'Edit(./orchestration/STATUS.md)', 'Write(./orchestration/STATUS.md)', 'Edit(./orchestration/rules.md)', 'Write(./orchestration/rules.md)'].includes(t)) continue;
      assert.equal(t, allowed, `${n}: ${t}`);
      assert.ok(!t.includes('..') && !t.includes('**'), `${n}: ${t} is broad`);
    }
  }
  assert.ok(splitTools(run.front['allowed-tools']).includes(allowed));
});

test('every plugin file an agent or skill reads is under rules/ and covered by the run grant', () => {
  const rulesReads = [...fs.readFileSync(path.join(PLUGIN, 'agents', 'nestor.md'), 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/[\w.-]+/g)];
  assert.ok(rulesReads.length >= 2);
  const body = run.body;
  for (const m of rulesReads) assert.ok(body.includes(m[0]), m[0]);
  for (const f of ['grunt', 'worker']) {
    const t = fs.readFileSync(path.join(PLUGIN, 'agents', `${f}.md`), 'utf8');
    assert.ok(!/Read[^.\n]*\$\{CLAUDE_PLUGIN_ROOT\}\/(?!rules\/)/.test(t), `${f}.md reads outside rules/`);
  }
});

test('run skill gates before the first spawn, the grunt included', () => {
  const gate = run.body.search(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/usage-gate\.mjs" .*--action orch/);
  const grunt = run.body.search(/spawn your own `nestor:grunt`/);
  const subOrch = run.body.search(/`subagent_type: nestor:nestor`/);
  assert.ok(gate >= 0 && grunt > gate && subOrch > gate, 'gate, then grunt, then nestor:nestor');
});

test('run skill sizes and stops its timer, reads HANDOFF-TEXT and stops headless', () => {
  assert.match(run.body, /`sleep` for `gate\.timerMin` minutes with `run_in_background: true`/);
  assert.match(run.body, /Once the last return word has arrived, stop your pending timers with `TaskStop`/);
  assert.match(run.body, /A reply with `HANDOFF-TEXT:` gives the handoff/);
  assert.match(run.body, /pass it verbatim in the next `RESUME` or spawn prompt; quote it in your final report/);
  assert.match(run.body, /the gate prints `headless: true`\) write the status file/);
});

test('run skill checks its own context with tick.mjs', () => {
  assert.match(run.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tick\.mjs" .*--session-id \$\{CLAUDE_SESSION_ID\}/);
  assert.match(run.body, /`core\.md` §5/);
});

test('run skill prints config with --print and gates with --action orch', () => {
  assert.match(run.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/config\.mjs" --print/);
  assert.match(run.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/usage-gate\.mjs" .*--action orch/);
  assert.match(run.body, /\$ARGUMENTS/);
});

test('run skill heads use NESTOR-RUN and NESTOR-TAG', () => {
  assert.match(run.body, /NESTOR-RUN: <project> PATHWAY: <p>/);
  assert.match(run.body, /NESTOR-TAG: <project>-<wp>-n<k>-<4 hex>/);
  assert.match(run.body, /GRUNT-TAG: controller-grunt1-<4 hex>/);
  assert.match(run.body, /`nestor:nestor`/);
  assert.match(run.body, /`nestor:grunt`/);
  assert.match(run.body, /`grunt\.controller`/);
  assert.match(run.body, /Grunt: off/);
});

test('run skill reads both rules files through the root', () => {
  assert.match(run.body, /In the rules, `<root>` is `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  assert.match(run.body, /\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/core\.md/);
  assert.match(run.body, /\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/workflow\.md/);
  assert.match(run.body, /orchestration\/rules\.md/);
});

test('every node command in the run skill matches an allowed-tools rule', () => {
  const rules = splitTools(run.front['allowed-tools']).map((t) => t.slice('Bash('.length, -' *)'.length) + ' ');
  const starts = [...run.body.matchAll(/\bnode /g)].map((x) => x.index);
  assert.ok(starts.length > 0);
  for (const i of starts) {
    assert.ok(rules.some((r) => run.body.startsWith(r, i)), run.body.slice(i, i + 80));
  }
});

// ---- Task 5: setup and teardown skills ----

import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN } from './skill-helpers.mjs';

const SKILLS = fs.readdirSync(path.join(PLUGIN, 'skills'));
const setup = loadSkill('setup');
const teardown = loadSkill('teardown');
const SETUP_RULE = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" *)';
const CONFIG_RULE = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *)';

test('every skill under plugins/nestor/skills is user-only', () => {
  assert.deepEqual([...SKILLS].sort(), ['config', 'run', 'setup', 'teardown']);
  for (const n of SKILLS) {
    const s = loadSkill(n);
    assert.equal(s.front.name, n);
    assert.equal(s.front['disable-model-invocation'], 'true', n);
    assert.ok(s.front.description && s.front.description.length > 10, n);
  }
});

test('every skill pre-approves only named scripts', () => {
  for (const n of SKILLS) assertNamedScriptsOnly(n);
  assert.deepEqual(splitTools(setup.front['allowed-tools']), [SETUP_RULE, CONFIG_RULE, 'AskUserQuestion']);
  assert.deepEqual(splitTools(teardown.front['allowed-tools']), [SETUP_RULE, 'AskUserQuestion']);
});

test('setup skill asks before --apply', () => {
  const ask = setup.body.search(/question tool/);
  const apply = setup.body.search(/setup\.mjs" --apply/);
  assert.ok(ask >= 0 && apply > ask, 'the question comes before the --apply call');
  assert.match(setup.body, /setup\.mjs" --check --cc-version/);
  assert.match(setup.body, /settings\.json\.nestor\.bak/);
});

test('setup skill gets the version without a pre-approved claude call', () => {
  assert.match(setup.body, /claude --version/);
  assert.ok(!splitTools(setup.front['allowed-tools']).some((t) => /claude/.test(t)));
  assert.match(setup.body, /--cc-version/);
});

test('setup skill calls config.mjs --set for offers', () => {
  assert.match(setup.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/config\.mjs" --set gate\.enabled=false/);
  assert.match(setup.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/config\.mjs" --set gate\.fiveHour\.enabled=false/);
  assert.match(setup.body, /\/nestor:config/);
  assert.match(setup.body, /ctx-meter:setup/);
});

test('teardown asks before --purge-config', () => {
  const purge = teardown.body.search(/--purge-config/);
  assert.ok(purge > 0);
  const firstRun = teardown.body.search(/setup\.mjs" --teardown/);
  const asks = [...teardown.body.slice(0, firstRun).matchAll(/question tool[^\n]*/g)].map((m) => m[0]);
  assert.equal(asks.length, 2, 'two separate questions before the script runs');
  assert.match(asks[1], /NestOr config/);
  assert.match(teardown.body, /\/plugin uninstall nestor@nestor/);
  assert.match(teardown.body, /setup\.mjs" --teardown/);
});

test('every node command in setup and teardown matches an allowed-tools rule', () => {
  for (const s of [setup, teardown]) {
    const rules = splitTools(s.front['allowed-tools'])
      .filter((t) => t.startsWith('Bash('))
      .map((t) => t.slice('Bash('.length, -' *)'.length) + ' ');
    for (const m of s.body.matchAll(/\bnode "/g)) {
      assert.ok(rules.some((r) => s.body.startsWith(r, m.index)), s.body.slice(m.index, m.index + 80));
    }
  }
});

test('no absolute path in any skill', () => {
  for (const n of SKILLS) {
    const { text } = loadSkill(n);
    assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[/\\]/.test(text.replace(/https?:\/\/\S+/g, '')), `${n}: drive path`);
    assert.ok(!/(^|[\s"'`(])\/(Users|home|usr|etc|opt|var)\//.test(text), `${n}: unix path`);
    assert.ok(!/\bDevel\//.test(text), n);
  }
});
