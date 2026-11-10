// A fresh install allows only plain commands without a prompt, and a headless run denies the rest.
// So no skill, agent or rules file may tell the model to run a compound command, a mkdir or a date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN } from './skill-helpers.mjs';

const files = [
  ...fs.readdirSync(path.join(PLUGIN, 'skills')).map((n) => path.join('skills', n, 'SKILL.md')),
  ...fs.readdirSync(path.join(PLUGIN, 'agents')).map((n) => path.join('agents', n)),
  ...fs.readdirSync(path.join(PLUGIN, 'rules')).map((n) => path.join('rules', n)),
];

// Inline code spans, plus every line of every fenced block.
export function commandCandidates(text) {
  const out = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of text.matchAll(fence)) out.push(...m[1].split('\n').filter((l) => l.trim()));
  const inline = text.replace(fence, '');
  for (const m of inline.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

const SHELL = new Set(
  'node git sleep claude npm npx gh cat ls grep tail head mkdir date test pwd cd echo rm cp mv find jq sort wc env export set source sh bash pwsh powershell'.split(' '),
);
// The project's own test command is named as an example of what the user's rules must allow.
const NAMED_EXAMPLES = new Set(['npm test']);

// Returns a reason when the span is a shell command a fresh config may deny, else null.
export function badCommand(span) {
  // A single token (`$(...)`, `&&`, `mkdir`) names a forbidden form; it is not a command.
  if (!/\s/.test(span.trim())) return null;
  if (/^\s*\[\s/.test(span)) return 'test bracket';
  if (/\$\(|<<|`/.test(span)) return 'substitution or heredoc';
  if (/\S\s*(&&|\|\|)\s*\S/.test(span)) return 'chain';
  const s = span.replace(/<[^<>]*>/g, 'X').replace(/\[[^\[\]]*\]/g, '').trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+\S/.test(s)) return 'env prefix';
  const m = /^([a-z][\w.-]*)\s/.exec(s);
  if (!m || !SHELL.has(m[1])) return null;
  if (NAMED_EXAMPLES.has(s)) return null;
  const bare = s.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (/&&|\|\||;|\||>|<|&|\$\(|`/.test(bare)) return 'operator';
  if (s === 'claude --version') return null;
  if (!['node', 'git', 'sleep'].includes(m[1])) return `command ${m[1]}`;
  return null;
}

test('the checker catches the forms a fresh config denies', () => {
  const bad = [
    'mkdir orchestration', 'mkdir -p orchestration', 'date -Iseconds', 'node x > out.txt', 'node x 2>&1', 'a || b',
    'node a | jq .', 'node a | sort', 'FOO=1 node x', 'cat f', 'ls d', 'pwd x', 'gh pr view 1', 'npm test | tail',
    'node a; Node b', 'node a;./b', 'node a & node b', '[ -f x ]', 'cd wt && git status', 'git commit -m "$(cat f)"',
    'test -f x', 'git a && git b',
  ];
  assert.deepEqual(bad.filter((s) => !badCommand(s)), []);
  const good = [
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --set <key>=<value>',
    'node <root>/scripts/usage-gate.mjs --path <p> --action <orch|worker|opus> [--wait] --log orchestration/usage-log.jsonl',
    'git branch --show-current', 'git commit -m "<summary>"', 'sleep <n>', 'claude --version', 'mkdir', '&&', 'npm test',
    'NESTOR-RUN: <project> PATHWAY: <p>',
  ];
  assert.deepEqual(good.filter((s) => badCommand(s)), []);
  assert.ok(commandCandidates('a\n```\ncd x && node y\n```\n`git z`').includes('cd x && node y'));
});

test('no plugin text asks for a command a fresh config denies', () => {
  const found = [];
  for (const f of files) {
    for (const s of commandCandidates(fs.readFileSync(path.join(PLUGIN, f), 'utf8'))) {
      const why = badCommand(s);
      if (why) found.push(`${f}: ${why}: ${s}`);
    }
  }
  assert.deepEqual(found, []);
});

const GRANTS = ['HANDOFF-*.md', 'STATUS.md', 'rules.md'].flatMap((n) => [`Edit(./orchestration/${n})`, `Write(./orchestration/${n})`]);

test('the run skill says the gate creates orchestration/ and grants writes to named files only', () => {
  const run = fs.readFileSync(path.join(PLUGIN, 'skills', 'run', 'SKILL.md'), 'utf8');
  assert.match(run, /The script creates `orchestration\/` if it is missing/);
  const line = /^allowed-tools: (.*)$/m.exec(run)[1];
  for (const g of GRANTS) assert.ok(line.includes(g), g);
  assert.ok(!/orchestration\/\*/.test(line), 'no folder-wide grant');
});

test('no plugin text tells an agent to write an orchestration/ file outside the grant', () => {
  const ok = /^orchestration\/(HANDOFF-[^/]*\.md|STATUS\.md|rules\.md|usage-log\.jsonl|)$/;
  const found = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(PLUGIN, f), 'utf8');
    for (const m of t.matchAll(/orchestration\/[\w<>*.-]*/g)) {
      if (!ok.test(m[0].replace(/<[^>]*>/g, 'x'))) found.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the command rule reaches the worker rules file and every brief', () => {
  const wf = fs.readFileSync(path.join(PLUGIN, 'rules', 'workflow.md'), 'utf8');
  const nestor = fs.readFileSync(path.join(PLUGIN, 'agents', 'nestor.md'), 'utf8');
  assert.match(wf, /Put these worker rules into the run's shared rules file[\s\S]*the command rule/);
  assert.match(wf, /command rule into every worker and\s+reviewer brief/);
  for (const t of [wf, nestor]) {
    assert.match(t, /heredocs/);
    assert.match(t, /git commit -m "<summary>"`, one more `-m "<paragraph>"` per paragraph/);
  }
  assert.match(nestor, /Every worker and reviewer brief you write carries this rule/);
});
