import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor');

export function loadSkill(name) {
  const text = fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}: frontmatter present`);
  const front = Object.fromEntries(
    m[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  return { text, front, body: m[2] };
}

// Splits like Claude Code: on commas and whitespace, but not inside (...).
export function splitTools(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of s ?? '') {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Rule of workflow.md section 6: a skill pre-approves no bare Bash or PowerShell and no
// interpreter prefix; each Bash entry names one existing script of the plugin.
// Returns the list of Bash entries so a caller can compare them further.
export function assertNamedScriptsOnly(skillName) {
  const { front } = loadSkill(skillName);
  const tools = splitTools(front['allowed-tools']);
  const entry = /^Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w-]+)\.mjs" \*\)$/;
  const bash = [];
  for (const t of tools) {
    assert.ok(!/^(Bash|PowerShell)$/.test(t), `${skillName}: bare ${t}`);
    assert.ok(!t.includes(':*'), `${skillName}: prefix form ${t}`);
    if (/^(Bash|PowerShell)\(/.test(t)) {
      const m = entry.exec(t);
      assert.ok(m, `${skillName}: ${t} is not a named-script rule`);
      assert.ok(fs.existsSync(path.join(PLUGIN, 'scripts', `${m[1]}.mjs`)), `${skillName}: scripts/${m[1]}.mjs exists`);
      bash.push(t);
    }
  }
  return bash;
}
