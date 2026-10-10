/**
 * v3.32.0: the recall character budget. Off by default, and when it is off the
 * result must come back untouched. When it is on, the best-ranked memories stay
 * complete, the rest become snippets that keep their id, and every shortened
 * memory is handed back in full so it can be expanded. Pure tests, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecallBudget,
  resolveRecallBudget,
  trimRelatedPreview,
  SNIPPET_CHARS,
  RELATED_PREVIEW_CHARS,
} from '../build/recall-budget.js';

const mem = (id, len, extra = {}) => ({ id, content: 'x'.repeat(len), subject: `s${id}`, importance: 5, ...extra });
const sample = () => ({
  memories: [mem(1, 3000), mem(2, 3000), mem(3, 3000), mem(4, 200), mem(5, 3000)],
  team_memories: [mem(6, 3000)],
  total: 6,
});

test('no budget returns the very same object', () => {
  const input = sample();
  const before = JSON.stringify(input);
  for (const budget of [0, -1, NaN, undefined]) {
    const { result, shortened } = applyRecallBudget(input, budget);
    assert.equal(result, input, `budget ${budget} must not copy or change the result`);
    assert.equal(shortened.size, 0);
  }
  assert.equal(JSON.stringify(input), before);
});

test('a budget large enough for everything changes nothing', () => {
  const input = sample();
  const { result, shortened } = applyRecallBudget(input, 100000);
  assert.equal(result, input);
  assert.equal(shortened.size, 0);
  assert.equal('truncated_note' in result, false);
});

test('best-ranked memories stay complete, the rest become snippets', () => {
  const input = sample();
  const before = JSON.stringify(input);
  const { result, shortened } = applyRecallBudget(input, 6000);
  const [a, b, c, d, e] = result.memories;
  assert.equal(a.content.length, 3000);
  assert.equal(b.content.length, 3000);
  assert.equal(a.truncated, undefined);
  assert.equal(c.truncated, true);
  assert.equal(c.full_chars, 3000);
  assert.ok(c.content.endsWith(' [...]'));
  assert.ok(c.content.length <= SNIPPET_CHARS + 6);
  assert.equal(d.content.length, 200, 'a short memory is never cut');
  assert.equal(d.truncated, undefined);
  assert.equal(e.truncated, true);
  assert.equal(result.team_memories[0].truncated, true, 'team memories share the budget');
  // metadata survives on a shortened memory
  assert.equal(c.id, 3);
  assert.equal(c.subject, 's3');
  assert.equal(c.importance, 5);
  // the full copies are handed back for expansion
  assert.deepEqual([...shortened.keys()], [3, 5, 6]);
  assert.equal(shortened.get(3).content.length, 3000);
  // the note names exactly the shortened ids and how to get them
  assert.match(result.truncated_note, /3 of 6 memories/);
  assert.match(result.truncated_note, /expand_ids: \[3, 5, 6\]/);
  assert.match(result.truncated_note, /max_chars: 0/);
  assert.equal(result.total, 6);
  // the input was not mutated
  assert.equal(JSON.stringify(input), before);
});

test('the first memory is complete even when it alone exceeds the budget', () => {
  const input = { memories: [mem(1, 9000), mem(2, 3000)], total: 2 };
  const { result, shortened } = applyRecallBudget(input, 1000);
  assert.equal(result.memories[0].content.length, 9000);
  assert.equal(result.memories[1].truncated, true);
  assert.deepEqual([...shortened.keys()], [2]);
});

test('a memory without an id is never cut, because it could not be asked for again', () => {
  const input = { memories: [mem(1, 3000), { content: 'y'.repeat(3000) }, mem(3, 3000)] };
  const { result, shortened } = applyRecallBudget(input, 1000);
  assert.equal(result.memories[1].content.length, 3000);
  assert.equal(result.memories[1].truncated, undefined);
  assert.deepEqual([...shortened.keys()], [3]);
});

test('string ids and memory_id are both understood', () => {
  const input = { memories: [mem(1, 3000), { id: '42', content: 'y'.repeat(3000) }, { memory_id: 43, content: 'z'.repeat(3000) }] };
  const { shortened } = applyRecallBudget(input, 1000);
  assert.deepEqual([...shortened.keys()], [42, 43]);
});

test('odd shapes pass through untouched', () => {
  for (const input of [null, undefined, 'text', 7, [], { error: 'boom' }, { memories: 'nope' }, { memories: [null, 'x', { content: 5 }] }]) {
    const { result, shortened } = applyRecallBudget(input, 500);
    assert.equal(result, input);
    assert.equal(shortened.size, 0);
  }
});

test('other fields on the result are preserved', () => {
  const input = { ...sample(), synthesis: 'summary', contradictions: [{ a: 1 }] };
  const { result } = applyRecallBudget(input, 3000);
  assert.equal(result.synthesis, 'summary');
  assert.deepEqual(result.contradictions, [{ a: 1 }]);
  assert.equal('team_memories' in result, true);
  const noTeam = applyRecallBudget({ memories: [mem(1, 3000), mem(2, 3000)] }, 1000).result;
  assert.equal('team_memories' in noTeam, false, 'a key that was absent is not invented');
});

test('resolveRecallBudget: the call wins, then the environment, then off', () => {
  assert.equal(resolveRecallBudget(undefined, undefined), 0);
  assert.equal(resolveRecallBudget(undefined, ''), 0);
  assert.equal(resolveRecallBudget(undefined, '12000'), 12000);
  assert.equal(resolveRecallBudget(undefined, ' 8000 '), 8000);
  assert.equal(resolveRecallBudget(5000, '12000'), 5000);
  assert.equal(resolveRecallBudget(0, '12000'), 0, 'max_chars: 0 turns an environment budget off for one call');
  for (const bad of ['abc', '-5', '12k', '1e4', '0']) assert.equal(resolveRecallBudget(undefined, bad), 0, bad);
  assert.equal(resolveRecallBudget(-3, undefined), 0);
  assert.equal(resolveRecallBudget(9e9, undefined), 200000);
});

test('trimRelatedPreview shortens a long related memory and keeps its id', () => {
  const long = { memory_id: 9, stored: true, potentially_related: { memory_id: 4, subject: 'topic', similarity: 0.69, content: 'r'.repeat(3000) } };
  const before = JSON.stringify(long);
  const out = trimRelatedPreview(long);
  assert.equal(out.memory_id, 9);
  assert.equal(out.stored, true);
  assert.equal(out.potentially_related.memory_id, 4);
  assert.equal(out.potentially_related.subject, 'topic');
  assert.equal(out.potentially_related.similarity, 0.69);
  assert.equal(out.potentially_related.content_truncated, true);
  assert.equal(out.potentially_related.content_chars, 3000);
  assert.ok(out.potentially_related.content.length <= RELATED_PREVIEW_CHARS + 6);
  assert.equal(JSON.stringify(long), before, 'input not mutated');
});

test('trimRelatedPreview leaves everything else alone', () => {
  const short = { memory_id: 9, potentially_related: { memory_id: 4, content: 'brief' } };
  assert.equal(trimRelatedPreview(short), short);
  for (const input of [null, undefined, 'x', [], { memory_id: 1 }, { potentially_related: null }, { potentially_related: 'x' }, { potentially_related: { content: 7 } }]) {
    assert.equal(trimRelatedPreview(input), input);
  }
});
