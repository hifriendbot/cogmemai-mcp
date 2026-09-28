/**
 * v3.29.0: the Stop review outside git reads the session's edit-event log.
 * Pure tests on the event reader and diff builder, plus one end-to-end run of
 * reviewWorkingTree in a temp folder that is not a repository (no API key, so
 * no network: the secrets check is what must fire).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEditEvents, editEventsToDiff, reviewWorkingTree, reviewFromEvents } from '../build/guard-review.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'cogmemai-review-')); }

test('edit events are read after an offset and only edits count', () => {
  const dir = tmp();
  const p = join(dir, 'events.jsonl');
  const lines = [
    JSON.stringify({ ts: 't', tool: 'Bash', input: { command: 'ls' } }),
    JSON.stringify({ ts: 't', tool: 'Edit', input: { file_path: join(dir, 'a.php'), old_string: 'x = 1', new_string: 'x = 2' } }),
    'not json',
    JSON.stringify({ ts: 't', tool: 'Write', input: { file_path: join(dir, 'sub', 'b.ts'), content: 'export const b = 1;' } }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  const all = readEditEvents(p, 0);
  assert.equal(all.events.length, 2);
  assert.equal(all.events[0].tool, 'Edit');
  assert.equal(all.events[1].newText, 'export const b = 1;');
  const later = readEditEvents(p, all.size);
  assert.equal(later.events.length, 0, 'nothing new after the recorded size');
  assert.equal(later.size, all.size);
});

test('events become a diff the intent judge can read, with cwd-relative paths', () => {
  const cwd = tmp();
  const { diff, files, added } = editEventsToDiff([
    { tool: 'Edit', file: join(cwd, 'app', 'main.py'), oldText: 'charge()', newText: 'validate()\ncharge()' },
    { tool: 'Write', file: join(cwd, 'notes.md'), oldText: '', newText: 'hello' },
  ], cwd);
  assert.deepEqual(files, ['app/main.py', 'notes.md']);
  assert.match(diff, /--- a\/app\/main\.py/);
  assert.match(diff, /^-charge\(\)$/m);
  assert.match(diff, /^\+validate\(\)$/m);
  assert.match(diff, /written whole file/);
  assert.deepEqual(added, ['validate()', 'charge()', 'hello']);
});

test('outside git, a pasted secret in an edit is reported from the event log', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, 'src'));
  const events = join(cwd, 'events.jsonl');
  // Assembled at runtime so the repository never contains a key-shaped literal.
  const fakeKey = ['sk', 'ant', 'api03'].join('-') + '-' + 'a1b2c3d4'.repeat(6);
  writeFileSync(events, JSON.stringify({ ts: 't', tool: 'Edit', input: { file_path: join(cwd, 'src', 'config.js'), old_string: 'KEY = ""', new_string: 'KEY = "' + fakeKey + '"' } }) + '\n');
  let fp = '';
  const notes = await reviewWorkingTree(cwd, {
    apiKey: '', apiBase: 'http://127.0.0.1:9', timeoutMs: 100, userAgent: 't', projectId: 'p', intent: null,
    eventsPath: events, lastFingerprint: '', onFingerprint: (f) => { fp = f; },
  });
  assert.ok(notes.some((n) => /secret|key|credential/i.test(n)), 'expected a secrets note, got: ' + JSON.stringify(notes));
  assert.match(fp, /^events:\d+$/);
  const again = await reviewFromEvents(cwd, { apiKey: '', apiBase: 'http://127.0.0.1:9', timeoutMs: 100, userAgent: 't', projectId: 'p', intent: null, eventsPath: events, lastFingerprint: fp });
  assert.deepEqual(again, [], 'the same events are not reviewed twice');
});
