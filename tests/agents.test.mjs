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
  assert.equal(f('grunt').tools, 'Bash, PowerShell, Read, Edit, Write, Glob, Grep, SendMessage, ToolSearch');
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
  assert.match(A.nestor.body, /\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/core\.md/);
  assert.match(A.nestor.body, /\$\{CLAUDE_PLUGIN_ROOT\}\/rules\/workflow\.md/);
});

test('nestor body has the root sentence, the pending-wait lines and the grunt switch', () => {
  const b = A.nestor.body;
  assert.match(b, /In the rules, `<root>` is `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  assert.match(b, /pending/i);
  assert.match(b, /run_in_background/);
  assert.match(b, /`grunt\.subOrch`/);
  assert.match(b, /Grunt: off/);
  assert.match(b, /orchestration\/rules\.md/);
  assert.match(b, /`nestor:worker`/);
  assert.match(b, /`nestor:grunt`/);
});

test('nestor body stops its timers and hands HANDOFF-TEXT to the controller', () => {
  const b = A.nestor.body;
  assert.match(b, /`sleep` for `gate\.timerMin` minutes/);
  assert.match(b, /stop your pending timers with `TaskStop`/);
  assert.match(b, /under `HANDOFF-TEXT:`/);
  assert.match(b, /The controller then writes it to the handoff file or passes it to the next sub-orchestrator/);
});

test('grunt uses exactly the reply channel the task names', () => {
  const b = A.grunt.body;
  assert.match(b, /`REPLY: text` \(your caller is the main session\): don't use `SendMessage`/);
  assert.match(b, /`REPLY: message` \(your caller is a sub-orchestrator\): send the reply with `SendMessage`/);
  assert.match(b, /end your turn with the single line `TASK <id>: sent` and nothing else/);
});

test('nestor body: REPLY message, no timer for workers, KEEPWARM answer', () => {
  const b = A.nestor.body;
  assert.match(b, /carries `REPLY: message`/);
  assert.match(b, /need no timer: a running background agent is pending/);
  assert.match(b, /`KEEPWARM <n>`.*single word `OK`: no tool call, no tick/);
});

test('grunt sends SendMessage only to the from id of its task', () => {
  const b = A.grunt.body;
  assert.match(b, /Use `SendMessage` only to reply to the `from` id of the task you are doing; never message any other agent\./);
  assert.match(b, /counts a reply that arrives both ways once/);
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
