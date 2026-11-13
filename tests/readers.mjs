// Who reads which rules file at start-up, and helpers over the rules text.
// RULES_DIR overrides the rules folder (used to prove a test fails on a broken copy).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN = path.join(ROOT, 'plugins', 'nestor');
export const RULES = process.env.RULES_DIR || path.join(PLUGIN, 'rules');
export const RULE_FILES = ['core.md', 'workflow.md', 'controller.md', 'replies.md', 'grunt-use.md'];

const norm = (t) => t.replace(/\r\n/g, '\n');
export const readRule = (name) => norm(fs.readFileSync(path.join(RULES, name), 'utf8'));
/** An agent or skill file without its frontmatter: what the agent gets as its prompt. */
export const readBody = (rel) => norm(fs.readFileSync(path.join(PLUGIN, rel), 'utf8')).replace(/^---\n[\s\S]*?\n---\n/, '');

// Start-up reading per orchestrator role: its prompt body, the rules it always reads, the rules it adds with a grunt.
export const READERS = {
  suborch: { body: 'agents/nestor.md', always: ['core.md', 'workflow.md'], grunt: ['replies.md', 'grunt-use.md'] },
  controller: {
    body: 'skills/run/SKILL.md',
    always: ['core.md', 'controller.md', 'replies.md', 'workflow.md'],
    grunt: ['grunt-use.md'],
  },
};

/** Texts a role reads at start-up: [[name, text], ...]. */
export function readerTexts(role, withGrunt) {
  const r = READERS[role];
  const files = withGrunt ? [...r.always, ...r.grunt] : r.always;
  return [[r.body, readBody(r.body)], ...files.map((f) => [f, readRule(f)])];
}

export const bytes = (s) => Buffer.byteLength(s, 'utf8');

const KEY_SPAN = /^(gate|fiveHour|weekly|context|cache|agents|grunt|worker)\./;
export const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

export function expand(span) {
  let out = [span];
  const sub = (token, values) => {
    out = out.flatMap((s) => (s.includes(token) ? values.map((v) => s.split(token).join(v)) : [s]));
  };
  sub('<p>', ['slow', 'fast']);
  sub('<action>', ['orch', 'worker', 'opus']);
  return out;
}

const KEY_TOKEN = /(?<![\w.\/-])(?:gate|fiveHour|weekly|context|cache|agents|grunt|worker)\.[\w.<>]*[\w>]/g;

/** Config keys named in `text` inside code spans, also within a longer span, `<p>` and `<action>` expanded. */
export function namedKeys(text) {
  return [...new Set(spans(text).flatMap((s) => (KEY_SPAN.test(s) ? [s] : s.match(KEY_TOKEN) ?? [])).flatMap(expand))];
}

export const ALL_KEYS = Object.keys(flatten(DEFAULTS));
