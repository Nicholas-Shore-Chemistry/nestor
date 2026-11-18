import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkill, splitTools, assertNamedScriptsOnly } from './skill-helpers.mjs';
import { ON_DEMAND, READERS } from './readers.mjs';

const run = loadSkill('run');

test('run skill is user-only', () => {
  assert.equal(run.front.name, 'run');
  assert.equal(run.front['disable-model-invocation'], 'true');
  assert.ok(run.front.description && run.front.description.length > 10);
});

test('run skill pre-approves only named scripts', () => {
  const bash = assertNamedScriptsOnly('run');
  assert.deepEqual(splitTools(run.front['allowed-tools']), [
    // --print only: every agent of a run inherits the grants, and --set could turn the gate off
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --print *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" *)',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/wait.mjs" *)',
    'Read(${CLAUDE_PLUGIN_ROOT}/rules/*)',
    'Edit(./orchestration/HANDOFF-*.md)',
    'Write(./orchestration/HANDOFF-*.md)',
    'Edit(./orchestration/STATUS.md)',
    'Write(./orchestration/STATUS.md)',
    'Edit(./orchestration/rules.md)',
    'Write(./orchestration/rules.md)',
  ]);
  assert.equal(bash.length, 5);
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

// Every plugin path an agent or skill names is either a script it runs or a rules file it reads. A rules file sits
// directly in rules/, so the run grant `Read(${CLAUDE_PLUGIN_ROOT}/rules/*)` covers it; both kinds must exist.
test('every plugin path an agent or skill names is an existing script or a rules file the run grant covers', () => {
  const texts = [
    ...fs.readdirSync(path.join(PLUGIN, 'agents')).map((f) => [`agents/${f}`, path.join(PLUGIN, 'agents', f)]),
    ...fs.readdirSync(path.join(PLUGIN, 'skills')).map((n) => [`skills/${n}`, path.join(PLUGIN, 'skills', n, 'SKILL.md')]),
  ].map(([n, p]) => [n, fs.readFileSync(p, 'utf8')]);
  let rulesRefs = 0;
  for (const [n, t] of texts) {
    for (const m of t.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`"')*]+)/g)) {
      const rel = m[1].replace(/[.,;:]+$/, '');
      // the pattern a body states for running any of its scripts, and the run skill's own `rules/*` grant
      if (rel === 'scripts/<name>.mjs' || rel === 'rules/') continue;
      if (/^rules\/[\w.-]+\.md$/.test(rel)) rulesRefs++;
      else assert.match(rel, /^scripts\/[\w-]+\.mjs$/, `${n}: ${rel} is neither a script nor a rules file`);
      assert.ok(fs.existsSync(path.join(PLUGIN, rel)), `${n}: ${rel} does not exist`);
    }
  }
  assert.ok(rulesRefs >= 6, `${rulesRefs} rules reads found`);
});

test('rules/ holds exactly the rules files the readers load, nothing else the grant would open', () => {
  const named = new Set(Object.values(READERS).flatMap((r) => [...r.always, ...r.grunt]));
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, 'rules')).sort(), [...named, ...ON_DEMAND].sort());
});

test('run skill gates before the first spawn, the grunt included', () => {
  const gate = run.body.search(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/usage-gate\.mjs" .*--action orch/);
  const grunt = run.body.search(/spawn your own `nestor:grunt`/);
  const subOrch = run.body.search(/`subagent_type: nestor:nestor`/);
  assert.ok(gate >= 0 && grunt > gate && subOrch > gate, 'gate, then grunt, then nestor:nestor');
});

test('run skill leaves timers, HANDOFF-TEXT, keep-warm and headless to the controller rules', () => {
  assert.match(run.body, /Handle the return words, the waits, the timers, `HANDOFF-TEXT:` and your context cap as the rules say \(`controller\.md` §1 to §4, `replies\.md`\)/);
  assert.match(run.body, /If the verdict is not `GO`, follow `controller\.md` §2, headless included/);
  for (const re of [/gate\.timerMin/, /run_in_background/, /TaskStop/, /REPLY:/, /no `&&`/])
    assert.doesNotMatch(run.body, re);
});

test('run skill checks its own context with tick.mjs', () => {
  assert.match(run.body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tick\.mjs" .*--session-id \$\{CLAUDE_SESSION_ID\}/);
  assert.match(run.body, /your context cap/);
});

test('run skill prints one config block per role and gates with --action orch', () => {
  for (const r of ['controller', 'suborch', 'worker'])
    assert.match(run.body, new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/config\\.mjs" --print --role ${r}\``), r);
  assert.match(run.body, /the `suborch` block, the `worker` line, the brief path, and last, when `controller\.md` §4 says so, the passed handoff under `HANDOFF-TEXT:`/);
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

test('run skill reads its rules files through the root, grunt-use.md only behind the grunt switch', () => {
  assert.match(run.body, /In the rules, `<root>` is `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  for (const f of ['core', 'controller', 'replies', 'workflow'])
    assert.match(run.body, new RegExp(`1\\. Read .*\\$\\{CLAUDE_PLUGIN_ROOT\\}/rules/${f}\\.md`), f);
  assert.match(run.body, /If `grunt\.controller` is true and the brief doesn't say `Grunt: off`, Read `\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/grunt-use\.md`/);
  assert.match(run.body, /orchestration\/rules\.md/);
});

// Every `node` command anywhere in a skill body (inline span, fenced block, or after a prefix such as `cd x && `)
// must start with one of that skill's Bash rules. Only Bash entries are rules for commands.
export function unmatchedNodeCommands(body, allowedTools) {
  const rules = splitTools(allowedTools)
    .filter((t) => t.startsWith('Bash(') && t.endsWith(' *)'))
    .map((t) => t.slice('Bash('.length, -' *)'.length) + ' ');
  const found = [];
  for (const m of body.matchAll(/\bnode\s/g))
    if (!rules.some((r) => body.startsWith(r, m.index))) found.push(body.slice(m.index, m.index + 80));
  return found;
}

test('every node command in every skill matches one of its Bash rules', () => {
  for (const n of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    const s = loadSkill(n);
    assert.ok([...s.body.matchAll(/\bnode\s/g)].length > 0, `${n} names no node command`);
    assert.deepEqual(unmatchedNodeCommands(s.body, s.front['allowed-tools']), [], n);
  }
});

test('the node command check catches fenced, prefixed and unquoted forms', () => {
  const tools = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" *), Read(${CLAUDE_PLUGIN_ROOT}/rules/*)';
  const ok = 'Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" --path slow`.';
  assert.deepEqual(unmatchedNodeCommands(ok, tools), []);
  for (const bad of [
    'Run:\n```\nnode "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --show\n```',
    'Run `cd x && node "${CLAUDE_PLUGIN_ROOT}/scripts/other.mjs" --go`.',
    'Run node ${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs --path slow.',
    // a Read rule is no command rule, however it is sliced
    'Run `node ${CLAUDE_PLUGIN_ROOT}/rules/core.md`.',
  ])
    assert.equal(unmatchedNodeCommands(bad, tools).length, 1, bad);
});

// ---- setup and teardown skills ----

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

test('no absolute path in any skill', () => {
  for (const n of SKILLS) {
    const { text } = loadSkill(n);
    assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[/\\]/.test(text.replace(/https?:\/\/\S+/g, '')), `${n}: drive path`);
    assert.ok(!/(^|[\s"'`(])\/(Users|home|usr|etc|opt|var)\//.test(text), `${n}: unix path`);
    assert.ok(!/\bDevel\//.test(text), n);
  }
});
