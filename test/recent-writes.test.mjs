/**
 * v3.32.2: the local record of memories this machine just wrote. Ids and
 * timestamps only; entries age out; a missing or corrupt file is an empty
 * record, never an error. Pure file tests in a temp folder, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWrite, recentWriteIds, RECENT_WRITE_SECONDS } from '../build/recent-writes.js';

const dir = mkdtempSync(join(tmpdir(), 'cogmemai-writes-'));
const file = (name) => join(dir, name);
const T = 1_800_000_000;

test('a recorded write is recent, then ages out', () => {
  const p = file('a.json');
  recordWrite(101, p, T);
  recordWrite('102', p, T + 60);
  assert.deepEqual([...recentWriteIds(RECENT_WRITE_SECONDS, p, T + 120)].sort(), [101, 102]);
  // just inside and just outside the window
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T + RECENT_WRITE_SECONDS - 1).has(101), true);
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T + RECENT_WRITE_SECONDS).has(101), false);
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T + RECENT_WRITE_SECONDS).has(102), true);
});

test('writing again refreshes the time, and old entries are pruned from the file', () => {
  const p = file('b.json');
  recordWrite(1, p, T);
  recordWrite(2, p, T + 10);
  recordWrite(1, p, T + 20 * 3600);
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T + 21 * 3600).has(1), true);
  recordWrite(3, p, T + 30 * 3600);
  const stored = JSON.parse(readFileSync(p, 'utf-8'));
  assert.deepEqual(Object.keys(stored).sort(), ['1', '3'], 'the entry older than a day is gone');
});

test('only ids and times are stored', () => {
  const p = file('c.json');
  recordWrite(55, p, T);
  assert.equal(readFileSync(p, 'utf-8'), JSON.stringify({ 55: T }));
});

test('things that are not a memory id are ignored', () => {
  const p = file('d.json');
  for (const bad of [undefined, null, '', 'abc', 0, -4, 1.5, {}, [], NaN]) recordWrite(bad, p, T);
  assert.equal(existsSync(p), false, 'nothing was written');
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T).size, 0);
});

test('a missing or corrupt file is an empty record', () => {
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, file('missing.json'), T).size, 0);
  const p = file('e.json');
  for (const junk of ['not json', '[1,2,3]', '"text"', 'null', '{"7":"yesterday","x":5}']) {
    writeFileSync(p, junk);
    assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, p, T).size, 0, junk);
  }
  // and a write still succeeds on top of junk
  writeFileSync(p, 'not json');
  recordWrite(9, p, T);
  assert.deepEqual([...recentWriteIds(RECENT_WRITE_SECONDS, p, T + 1)], [9]);
});

test('an unwritable location never throws', () => {
  const blocker = file('blocker');
  writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => recordWrite(5, join(blocker, 'sub', 'f.json'), T));
  assert.equal(recentWriteIds(RECENT_WRITE_SECONDS, join(blocker, 'sub', 'f.json'), T).size, 0);
});
