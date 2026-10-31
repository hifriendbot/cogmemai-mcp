/**
 * v3.33.0: voice. The measurements must be right on known text, a .docx must read without any
 * dependency, the gateway reply must parse even when fenced, the drift check must flag the marks a
 * writer never uses, and nothing rendered may carry a dash. Pure tests, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { measure, formatMetrics, parseVoiceReply, drift, docxText, zipEntry, htmlText, excerpts, profileRuleContent, voiceIntent, renderCheck } from '../build/voice.js';

const PLAIN = `I built the first version in a weekend. It was ugly, but it worked, and that was the point.

Additionally, the server was cheap. We paid about twelve dollars a month for it. Also, nobody complained, which actually surprised me.

However, the real test came later. Did the thing hold up under load? It did, mostly. I think this shows that simple designs win when you are small.`;

const FORMAL = `The committee reviewed the proposal; it found three deficiencies. The first concerned scope\u2014the second, cost; the third, timing. Stakeholders were consulted. Recommendations follow! Furthermore, the methodology was deemed insufficient; consequently, additional analysis is required. Nevertheless, the committee acknowledges the effort\u2014and the constraints\u2014under which the team operated.`;

test('measure counts words, sentences, paragraphs, marks and openers on known text', () => {
  const m = measure(PLAIN);
  assert.equal(m.paragraphs, 3);
  assert.equal(m.sentences, 9);
  assert.ok(m.words > 60 && m.words < 80, `words ${m.words}`);
  assert.equal(m.per_1k.semicolons, 0);
  assert.equal(m.per_1k.em_dashes, 0);
  assert.ok(m.per_1k.first_person > 50, `first person ${m.per_1k.first_person}`);
  assert.equal(m.per_1k.contractions, 0);
  assert.equal(m.per_1k.adverbs_ly, 44.1, 'Additionally, actually, mostly; not ugly');
  assert.ok(m.transition_openers_share >= 0.25, `transitions ${m.transition_openers_share}`);
  assert.ok(m.closers.question_share > 0);
  assert.ok(m.openers.some((o) => o.word === 'i'));
  const text = formatMetrics(m, 1);
  assert.match(text, /Words \d+ in 1 sample; 9 sentences; 3 paragraphs/);
  assert.ok(!/[\u2014\u2013]/.test(text));
});

test('measure strips Markdown structure but counts it', () => {
  const md = `# A heading\n\n- first point here now\n- second point here now\n\nSome **bold** prose with a [link](https://example.com) and \`code\`.\n\n\`\`\`\nignored = true;\n\`\`\`\n`;
  const m = measure(md);
  assert.equal(m.markdown.headings, 1);
  assert.equal(m.markdown.bold, 1);
  assert.ok(m.markdown.bullets_share > 0.3);
  assert.ok(!/ignored/.test(JSON.stringify(m.signature_words)));
});

test('measure sees semicolons, dashes and exclamation marks in formal text', () => {
  const m = measure(FORMAL);
  assert.ok(m.per_1k.semicolons > 40, `semicolons ${m.per_1k.semicolons}`);
  assert.ok(m.per_1k.em_dashes > 20, `em dashes ${m.per_1k.em_dashes}`);
  assert.ok(m.per_1k.exclamations > 0);
  assert.equal(m.per_1k.first_person, 0);
});

test('drift flags the marks the writer never uses and the rhythm change', () => {
  const profile = measure(PLAIN + '\n\n' + PLAIN + '\n\n' + PLAIN);
  const r = drift(profile, measure(FORMAL), FORMAL);
  const texts = r.findings.map((f) => f.text).join(' | ');
  assert.match(texts, /semicolon/);
  assert.match(texts, /em dash/);
  assert.match(texts, /exclamation/);
  assert.ok(r.findings.filter((f) => f.severity === 'high').length >= 3);
  assert.ok(r.score < 60, `score ${r.score}`);
  const same = drift(profile, measure(PLAIN), PLAIN);
  assert.equal(same.findings.length, 0);
  assert.equal(same.score, 100);
});

test('parseVoiceReply accepts a fenced reply, prefixes subjects, tidies dashes and dedupes', () => {
  const reply = '```json\n' + JSON.stringify({
    name: 'plain builder voice',
    description: 'Short sentences \u2014 plain words. First person is normal. Paragraphs run three sentences. Openers lean on Additionally, Also and However. No semicolons at all, no em dashes, and questions appear now and then.',
    rules: [
      { subject: 'rhythm', content: 'ALWAYS keep sentences near 14 words on average and mix a short one into every paragraph.' },
      { subject: 'voice_semicolons', content: 'NEVER use a semicolon; the writer used none in 230 words.' },
      { subject: 'voice_semicolons', content: 'NEVER use an em dash \u2014 the writer used none.' },
      { subject: 'Person!', content: 'ALWAYS write in first person when the piece is an opinion or a report of work done.' },
      { content: 'ALWAYS open some paragraphs with Additionally, Also or However.' },
      { subject: 'short', content: 'too short' },
    ],
    sample_sentence: 'I shipped it on Friday \u2013 and it held.',
  }) + '\n```';
  const d = parseVoiceReply(reply);
  assert.equal(d.name, 'plain builder voice');
  assert.ok(!/[\u2014\u2013]/.test(JSON.stringify(d)));
  assert.equal(d.rules.length, 5);
  assert.deepEqual(d.rules.map((r) => r.subject), ['voice_rhythm', 'voice_semicolons', 'voice_semicolons_2', 'voice_person', 'voice_rule']);
  assert.throws(() => parseVoiceReply('no json here'), /no JSON object/);
  assert.throws(() => parseVoiceReply(JSON.stringify({ description: 'x'.repeat(50), rules: [] })), /usable rules/);
});

test('profile rule and intent document carry the voice and no dash', () => {
  const doc = parseVoiceReply(JSON.stringify({
    name: 'plain builder voice',
    description: 'Short sentences and plain words. First person is normal. No semicolons, no em dashes.',
    rules: [
      { subject: 'a', content: 'ALWAYS keep sentences short, near 14 words on average.' },
      { subject: 'b', content: 'NEVER use a semicolon anywhere in a draft.' },
      { subject: 'c', content: 'NEVER use an em dash or an en dash anywhere in a draft.' },
      { subject: 'd', content: 'ALWAYS write in first person for reports of work done.' },
    ],
  }));
  const rule = profileRuleContent('Scott', doc);
  assert.match(rule, /^ALWAYS write in Scott's own voice/);
  assert.match(rule, /the "plain builder voice"\. Short sentences/);
  assert.match(rule, /voice_check/);
  assert.match(rule, /\nGUARD: off$/);
  assert.ok(rule.length <= 1800);
  const intent = voiceIntent({ who: 'Scott', name: doc.name, description: doc.description, rules: doc.rules.map((r) => ({ ...r, content: r.content + '\nGUARD: off' })) });
  assert.match(intent, /^# Voice: plain builder voice \(Scott\)/);
  assert.match(intent, /## Invariants\n- ALWAYS keep sentences short/);
  assert.ok(!/GUARD/.test(intent));
  assert.ok(intent.length <= 6000);
});

function docxFixture(paragraphs) {
  const xml = `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const files = [
    ['[Content_Types].xml', Buffer.from('<Types/>'), false],
    ['word/document.xml', Buffer.from(xml, 'utf8'), true],
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const payload = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, payload);
    centrals.push(ch, n);
    offset += lh.length + n.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('docxText reads paragraphs out of a .docx with no dependency', () => {
  const buf = docxFixture(['First paragraph here &amp; more.', 'Second one, with a question?']);
  assert.ok(zipEntry(buf, 'word/document.xml'));
  assert.equal(zipEntry(buf, 'word/missing.xml'), null);
  const text = docxText(buf);
  assert.equal(text, 'First paragraph here & more.\n\nSecond one, with a question?');
  assert.throws(() => docxText(Buffer.from('not a zip')), /not a \.docx/);
});

test('htmlText keeps the words and the paragraph breaks', () => {
  const t = htmlText('<html><head><style>p{}</style></head><body><h1>Title</h1><p>One &amp; two.</p><p>Three<br>four.</p><script>x()</script></body></html>');
  assert.equal(t, 'Title\n\nOne & two.\n\nThree\nfour.');
});

test('excerpts stay under the budget and label their source', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} says something short and plain about the work.`).join('\n\n');
  const one = excerpts([{ name: 'notes.md', text: long }]);
  assert.match(one, /^\[notes\.md\]/);
  assert.match(one, /\[notes\.md, from 40% in\]/);
  assert.ok(one.length <= 7200);
  const many = excerpts([1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `f${i}.txt`, text: long })));
  assert.ok(!/f7\.txt/.test(many));
  assert.ok(many.length <= 7200);
});

test('renderCheck reads plainly and carries no dash', () => {
  const out = renderCheck({
    passed: false,
    min: 80,
    profile: { name: 'plain builder voice', who: 'Scott', scope: 'global', rules: 9 },
    local: { score: 70, findings: [{ severity: 'high', text: 'uses 2 semicolons; the writer uses none' }], metrics: '' },
    review: { judged: true, coverage: 85, violations: ['NEVER use a semicolon: two found'], uncovered: [], summary: 'Close, except the semicolons.' },
  });
  assert.match(out, /Drift check: 70\/100/);
  assert.match(out, /high: uses 2 semicolons/);
  assert.match(out, /Review: coverage 85, 1 violation\n/);
  assert.match(out, /FAILED/);
  assert.ok(!/[\u2014\u2013]/.test(out));
  assert.match(renderCheck({ passed: false, min: 80, profile: null, local: null, review: null, note: 'No global voice profile.' }), /No global voice profile/);
});
