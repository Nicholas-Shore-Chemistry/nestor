import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml');
const text = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

// Plain text job extraction: from "  name:" to the next two-space job key or end of file.
function job(name) {
  const m = new RegExp(`^  ${name}:\n(?:(?!  [A-Za-z0-9_-]+:\n)[^\n]*\n?)*`, 'm').exec(text);
  return m ? m[0] : '';
}

test('ci has jobs test and validate', () => {
  for (const n of ['test', 'validate']) assert.ok(job(n), `job ${n} missing`);
});

// The identity scan served the one-time push from the private repo; maintenance is now public-only.
test('ci has no identity scan job', () => {
  assert.equal(job('scan'), '');
  assert.doesNotMatch(text, /identity-scan|IDENTITY_DENYLIST/);
});

test('test and validate run on ubuntu-latest and windows-latest', () => {
  for (const n of ['test', 'validate']) {
    const j = job(n);
    assert.match(j, /os: \[ubuntu-latest, windows-latest\]/, n);
    assert.match(j, /runs-on: \$\{\{ matrix\.os \}\}/, n);
    assert.match(j, /fail-fast: false/, n);
  }
});

test('validate pins @anthropic-ai/claude-code to an exact version', () => {
  assert.match(job('validate'), /npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+\s*$/m);
});

test('validate runs validate --strict on plugins/nestor and on the repo root', () => {
  const j = job('validate');
  assert.match(j, /^\s+run: claude plugin validate --strict plugins\/nestor\s*$/m);
  assert.match(j, /^\s+run: claude plugin validate --strict \.\s*$/m);
});

test('validate keeps LF step, checkout without credentials, Node 22 and bash', () => {
  const j = job('validate');
  assert.match(j, /git config --global core\.autocrlf false/);
  assert.match(j, /persist-credentials: false/);
  assert.match(j, /node-version: 22/);
  assert.match(j, /shell: bash/);
});

test('validate has no continue-on-error and no if: that could skip it', () => {
  const j = job('validate');
  assert.doesNotMatch(j, /continue-on-error/);
  assert.doesNotMatch(j, /^\s+if:/m);
  assert.doesNotMatch(j, /\|\|\s*true/);
});

test('permissions contents read', () => {
  assert.match(text, /^permissions:\n  contents: read\n/m);
});
