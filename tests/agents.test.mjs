import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'agents');

// Small line parser: top-level "key: value" lines and one level of nested keys.
function parseAgent(name) {
  const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}: frontmatter present`);
  const front = {};
  let parent = null;
  for (const line of m[1].split('\n')) {
    const nested = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (nested && parent) {
      front[parent][nested[1]] = nested[2].trim();
      continue;
    }
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    assert.ok(top, `${name}: unparsable frontmatter line "${line}"`);
    if (top[2].trim() === '') {
      front[top[1]] = {};
      parent = top[1];
    } else {
      front[top[1]] = top[2].trim();
      parent = null;
    }
  }
  return { text, front, body: m[2] };
}

const A = Object.fromEntries(['nestor', 'worker', 'grunt'].map((n) => [n, parseAgent(n)]));

test('frontmatter per agent matches the spec', () => {
  const keys = (n) => Object.keys(A[n].front).sort();
  const f = (n) => A[n].front;
  assert.equal(f('nestor').name, 'nestor');
  assert.equal(f('nestor').model, 'opus');
  assert.equal(f('nestor').effort, 'medium');
  assert.equal(f('nestor').background, 'true');
  assert.equal(f('nestor').tools, 'Agent, Bash, Read, Edit, Write, Glob, Grep, SendMessage, TaskStop, ToolSearch');
  assert.deepEqual(f('nestor').experimental, { cacheTtl: '1h' });
  assert.deepEqual(keys('nestor'), ['background', 'description', 'effort', 'experimental', 'model', 'name', 'tools']);
  assert.equal(f('worker').name, 'worker');
  assert.equal(f('worker').model, 'sonnet');
  assert.equal(f('worker').background, 'true');
  assert.equal(f('worker').tools, 'Bash, Read, Edit, Write, Glob, Grep');
  assert.match(f('worker').description, /MCP tools, web access or skills goes to an ordinary agent type/);
  assert.deepEqual(f('worker').experimental, { cacheTtl: '1h' });
  assert.deepEqual(keys('worker'), ['background', 'description', 'experimental', 'model', 'name', 'tools']);
  assert.equal(f('grunt').name, 'grunt');
  assert.equal(f('grunt').model, 'haiku');
  assert.equal(f('grunt').background, 'true');
  assert.equal(f('grunt').tools, 'Bash, PowerShell, Read, Edit, Write, Glob, Grep, ToolSearch');
  assert.deepEqual(f('grunt').experimental, { cacheTtl: '1h' });
  assert.deepEqual(keys('grunt'), ['background', 'description', 'experimental', 'model', 'name', 'tools']);
  for (const n of Object.keys(A)) assert.ok(f(n).description.length > 20, `${n} description`);
});

test('no ignored plugin-agent fields', () => {
  for (const [n, a] of Object.entries(A)) {
    for (const k of ['hooks', 'mcpServers', 'permissionMode', 'initialPrompt']) {
      assert.ok(!(k in a.front), `${n} has ${k}`);
    }
  }
});

test('bodies use CLAUDE_PLUGIN_ROOT for scripts and rules', () => {
  for (const [n, a] of Object.entries(A)) {
    assert.match(a.body, /In the rules, `<root>` is `\$\{CLAUDE_PLUGIN_ROOT\}`/, `${n} root sentence`);
    for (const m of a.body.matchAll(/\bnode (\S+)/g)) {
      assert.ok(m[1].startsWith('"${CLAUDE_PLUGIN_ROOT}/scripts/'), `${n}: ${m[0]}`);
    }
    for (const m of a.body.matchAll(/\bscripts\/[\w-]+\.mjs/g)) {
      assert.ok(fs.existsSync(path.join(DIR, '..', m[0])), `${n}: ${m[0]} exists`);
    }
  }
  for (const f of ['core', 'workflow', 'replies', 'grunt-use'])
    assert.match(A.nestor.body, new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}/rules/${f}\\.md`), f);
});

test('nestor body has the root sentence and reads the grunt files only behind the grunt switch', () => {
  const b = A.nestor.body;
  assert.match(b, /In the rules, `<root>` is `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  assert.match(b, /only if `grunt\.subOrch` is true and the brief doesn't say `Grunt: off`, also `\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/replies\.md` and `\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/grunt-use\.md`/);
  assert.match(b, /orchestration\/rules\.md/);
  assert.match(b, /`nestor:grunt`/);
  assert.match(b, /Take every value from the config in your prompt, never from memory/);
});

test('nestor body leaves the timer, command, handoff and keep-warm rules to the rules files', () => {
  const b = A.nestor.body;
  for (const re of [/gate\.timerMin/, /run_in_background/, /TaskStop/, /no `&&`/, /HANDOFF-TEXT/, /KEEPWARM/, /REPLY:/])
    assert.doesNotMatch(b, re);
});

test('grunt replies once, by hand-back only', () => {
  const b = A.grunt.body;
  assert.match(b, /Reply once, with your end-of-turn text \(or a `SubagentHandback` call\): it reaches the agent that spawned you/);
  assert.match(b, /Never send a reply by `SendMessage` and never repeat a reply/);
  assert.match(b, /A `REPLY:` line in a task \(from NestOr 0\.2\.0 or older\) changes nothing: ignore it\./);
  assert.match(b, /- Never message any agent\./);
  assert.doesNotMatch(b, /TASK <id>: sent/);
  assert.doesNotMatch(b, /`from` id/);
});

test('worker body waits in the background, skips the gate and stops at worker.stopTurns', () => {
  const b = A.worker.body;
  assert.match(b, /`worker\.stopTurns`/);
  assert.match(b, /handoff/i);
  assert.match(b, /run_in_background: true/);
  assert.match(b, /Do not check usage/);
});

test('grunt body has GUARD-START and GUARD-END and ctx.mjs', () => {
  const b = A.grunt.body;
  assert.match(b, /GUARD-START/);
  assert.match(b, /GUARD-END/);
  assert.match(b, /`git branch --show-current` and then `git show -s --oneline HEAD`, as two separate commands/);
  assert.doesNotMatch(b, /show-current &&/);
  assert.match(b, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/ctx\.mjs" --tag "<your GRUNT-TAG>"/);
  assert.match(b, /ctx=\?/);
});

test('no copilot, tracker, ORCH-, Devel paths, drive paths', () => {
  // Written like rules.test.mjs so the identity scan does not flag this file.
  const bad = [/copilot/i, /tracker/i, /ORCH-(RUN|TAG)/, /orch-core/, /helpful-grunt/, /\bsub-orch\b/, /Devel[/]/, /[A-Z]:[\\/]/];
  for (const [n, a] of Object.entries(A)) assert.deepEqual(bad.filter((re) => re.test(a.text)).map(String), [], n);
});
