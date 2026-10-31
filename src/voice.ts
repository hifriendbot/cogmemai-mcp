/**
 * Voice: every Ai writes like you.
 *
 *   cogmemai-mcp voice learn <files...> [--name "..."] [--project] [--path DIR] [--model ID] [--dry-run]
 *   cogmemai-mcp voice check <file|-> [--min 80] [--project] [--path DIR]
 *   cogmemai-mcp voice show [--project] [--path DIR]
 *
 * learn reads writing the person wrote themselves (.txt, .md, .html, .docx, .pdf), measures it on this
 * machine (sentence rhythm, paragraphing, openers, punctuation habits, contractions, point of view,
 * vocabulary, signature words, formatting), sends the measurements and short excerpts to the MSGR
 * gateway once, and stores the result as rule memories: one voice_profile rule and eight to twelve
 * voice_rule_* rules. Rules load into every session of every connected Ai, so the voice applies
 * everywhere with no further step. The measurements are kept as a voice_metrics memory and a local
 * cache for the drift check.
 *
 * check measures a draft the same way, compares it with the profile (drift), and asks the review on
 * the server to judge the draft against the voice document. It passes at the threshold with no
 * violations, so it works as a gate before a draft is sent or published.
 *
 * This is for writing in the person's own voice on their own work. It is not a detector bypass and
 * is never tested against one.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { CloudStorage } from './storage-cloud.js';
import type { StorageBackend } from './storage.js';
import { projectIdFor, syncGuardRules } from './guard-hooks.js';
import { gatewayChat, tidy } from './migrate.js';
import { FLAG_DIR, VERSION } from './config.js';

// ── Reading ───────────────────────────────────────────────────

const MAX_SAMPLE_BYTES = 2_000_000;

const MAX_PDF_BYTES = 25_000_000;

/** Read a writing sample as plain text. Supported: .txt, .md, .markdown, .html, .htm, .docx, .pdf, and any UTF-8 text file. */
export async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  const st = statSync(path);
  if (ext === '.pdf') {
    if (st.size > MAX_PDF_BYTES) throw new Error(`${basename(path)} is larger than 25 MB; export the pages you want measured`);
    return pdfText(readFileSync(path), basename(path));
  }
  if (st.size > MAX_SAMPLE_BYTES) throw new Error(`${basename(path)} is larger than 2 MB; split it or export the part you want measured`);
  const buf = readFileSync(path);
  if (ext === '.docx') return docxText(buf, basename(path));
  if (ext === '.doc' || ext === '.rtf' || ext === '.odt') throw new Error(`${basename(path)}: save it as .docx, .pdf or .txt first`);
  if (looksBinary(buf)) throw new Error(`${basename(path)} is not a text file`);
  const text = buf.toString('utf-8').replace(/^﻿/, '');
  if (ext === '.html' || ext === '.htm') return htmlText(text);
  return text;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4000);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) zeros++;
  return n > 0 && zeros / n > 0.01;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Pull one file out of a ZIP archive (a .docx is a ZIP). Stored and deflated entries; no CRC check. */
export function zipEntry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name === wanted) {
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return null;
      const ln = buf.readUInt16LE(lho + 26);
      const lx = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + ln + lx;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

export function docxText(buf: Buffer, label = 'document'): string {
  const xml = zipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error(`${label}: not a .docx file (no word/document.xml inside)`);
  return decodeEntities(
    xml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text from a PDF through pdf.js (loaded only when a PDF is read). Lines are rebuilt from the
 * glyph positions; a paragraph break is a vertical gap well above the page's usual line spacing,
 * or a line that starts indented. Hyphens at line ends are joined. Scanned PDFs with no text
 * layer come back empty and are reported as such.
 */
export async function pdfText(buf: Buffer, label = 'document'): Promise<string> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error(`${label}: the PDF reader (pdfjs-dist) is not installed: ${(e as Error).message}`);
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      type Line = { x: number; y: number; parts: string[] };
      const lines: Line[] = [];
      let cur: Line | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const x = item.transform[4];
        const y = item.transform[5];
        if (!cur || Math.abs(y - cur.y) > 2) {
          cur = { x, y, parts: [] };
          lines.push(cur);
        }
        if (item.str) cur.parts.push(item.str);
        if (item.hasEOL) cur = null;
      }
      const texts = lines.map((l) => ({ x: l.x, y: l.y, text: l.parts.join(' ').replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
      if (!texts.length) continue;
      const gaps: number[] = [];
      for (let i = 1; i < texts.length; i++) {
        const g = Math.abs(texts[i - 1].y - texts[i].y);
        if (g > 0.5) gaps.push(g);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      // Lower median: the usual line spacing, even on a page with only a couple of lines.
      const lineGap = Math.max(4, sortedGaps.length ? sortedGaps[Math.floor((sortedGaps.length - 1) / 2)] : 12);
      const xs = texts.map((l) => Math.round(l.x)).sort((a, b) => a - b);
      const leftEdge = xs[Math.floor(xs.length * 0.25)];
      let out = '';
      for (let i = 0; i < texts.length; i++) {
        const l = texts[i];
        if (i === 0) {
          out = l.text;
          continue;
        }
        const gap = Math.abs(texts[i - 1].y - l.y);
        const newParagraph = gap > lineGap * 1.6 || l.x > leftEdge + 8;
        if (newParagraph) out += '\n\n' + l.text;
        else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(l.text)) out = out.slice(0, -1) + l.text;
        else out += ' ' + l.text;
      }
      pages.push(out);
    }
  } finally {
    await doc.destroy();
  }
  const text = pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error(`${label}: no text layer in this PDF (a scanned image needs OCR first)`);
  return text;
}

// ── Measuring ─────────────────────────────────────────────────

export interface VoiceMetrics {
  words: number;
  sentences: number;
  paragraphs: number;
  sentence_len: { mean: number; sd: number; median: number; short_share: number; long_share: number };
  paragraph_sentences: number;
  word_len: number;
  long_word_share: number;
  ttr: number;
  per_1k: {
    semicolons: number;
    colons: number;
    em_dashes: number;
    en_dashes: number;
    parentheses: number;
    exclamations: number;
    questions: number;
    quotes: number;
    ellipses: number;
    contractions: number;
    first_person: number;
    second_person: number;
    numbers: number;
    adverbs_ly: number;
    caps_words: number;
  };
  openers: Array<{ word: string; share: number }>;
  transition_openers_share: number;
  closers: { question_share: number; exclamation_share: number };
  signature_words: Array<{ word: string; per_1k: number }>;
  markdown: { bullets_share: number; headings: number; bold: number };
}

const STOP = new Set(
  (
    'a an the and or but nor so yet if then than as of in on at to for with from by about into over after before up down out off ' +
    'through under between among around across against during without within along toward upon per via is are was were be been being ' +
    'am have has had do does did will would can could should may might must shall this that these those it its they them their there ' +
    'here he she his her him we us our you your i me my mine who whom whose which what when where why how not no nor also any all each ' +
    'some such other another more most many much few less least own same both either neither one two three first new old because while ' +
    'although though since until unless whether every thing things way like get got make made use used go went come came take took ' +
    'see saw know knew think thought say said want need well even still back only'
  ).split(/\s+/)
);

const TRANSITIONS = new Set(
  'however also additionally but and so still yet then first second third finally meanwhile instead overall therefore thus moreover furthermore nevertheless nonetheless anyway basically honestly plus again likewise similarly conversely'.split(' ')
);
const NOT_ADVERBS = new Set('ugly only early family likely unlikely lonely friendly holy supply apply reply ally rally bully italy assembly monopoly anomaly belly jelly folly tally july'.split(' '));
const TRANSITION_PAIRS = new Set(['for example', 'for instance', 'in short', 'in fact', 'in addition', 'in other', 'on the', 'to me', 'that said', 'of course', 'as a', 'at the', 'even so', 'in my']);
const ABBREV = /\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|sr|jr|st|no|inc|ltd|co|u\.s|u\.k|a\.m|p\.m|fig|approx|dept|est)\./gi;

function words(s: string): string[] {
  return s.match(/[A-Za-z][A-Za-z'\u2019-]*/g) || [];
}

function splitSentences(paragraph: string): string[] {
  const protectedText = paragraph.replace(ABBREV, (m) => m.replace(/\./g, '\u0001')).replace(/(\d)\.(\d)/g, '$1\u0001$2');
  return protectedText
    .split(/(?<=[.!?]["'\u201d\u2019)\]]*)\s+(?=["'\u201c\u2018(\[]?[A-Z0-9])/)
    .map((s) => s.replace(/\u0001/g, '.').trim())
    .filter((s) => words(s).length > 0);
}

/** Markdown and formatting noise removed; the sentences keep their words and punctuation. */
function cleanForProse(text: string): { prose: string; markdown: VoiceMetrics['markdown'] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let bullets = 0;
  let headings = 0;
  let contentLines = 0;
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      kept.push('');
      continue;
    }
    contentLines++;
    let l = line;
    if (/^\s{0,3}#{1,6}\s/.test(l)) {
      headings++;
      l = l.replace(/^\s{0,3}#{1,6}\s+/, '');
      kept.push(l.trim() + (/[.!?]$/.test(l.trim()) ? '' : '.'), '');
      continue;
    }
    if (/^\s*([-*+\u2022]|\d+[.)])\s+/.test(l)) {
      bullets++;
      l = l.replace(/^\s*([-*+\u2022]|\d+[.)])\s+/, '');
    }
    l = l.replace(/^\s*>\s?/, '');
    kept.push(l);
  }
  const bold = (text.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) || []).length;
  const prose = kept
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/`[^`\n]*`/g, 'code')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ');
  return { prose, markdown: { bullets_share: contentLines ? bullets / contentLines : 0, headings, bold } };
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function measure(text: string): VoiceMetrics {
  const { prose, markdown } = cleanForProse(text);
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => words(p).length > 0);
  const sentences: string[] = [];
  for (const p of paragraphs) sentences.push(...splitSentences(p));
  const allWords = words(prose);
  const W = allWords.length || 1;
  const per1k = (n: number) => round((n / W) * 1000, 1);

  const lens = sentences.map((s) => words(s).length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length) : 0;
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const S = lens.length || 1;

  const letters = allWords.reduce((a, w) => a + w.replace(/[^A-Za-z]/g, '').length, 0);
  const longWords = allWords.filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 7).length;
  const firstN = allWords.slice(0, 2000).map((w) => w.toLowerCase());
  const ttr = firstN.length ? new Set(firstN).size / firstN.length : 0;

  const count = (re: RegExp) => (prose.match(re) || []).length;
  const contractions = count(/\b\w+(?:'|\u2019)(?:s|re|ve|ll|d|m|t)\b/gi);
  const firstPerson = count(/\b(I|me|my|mine|myself|we|us|our|ours|ourselves)\b/g) + count(/\b(We|Us|Our|Ours|Ourselves|Me|My|Mine|Myself)\b/g);
  const secondPerson = count(/\b(you|your|yours|yourself|yourselves)\b/gi);
  const numbers = count(/(?<![A-Za-z])\d[\d,.]*%?/g);
  const adverbs = allWords.filter((w) => /ly$/i.test(w) && w.length > 4 && !NOT_ADVERBS.has(w.toLowerCase())).length;
  const caps = allWords.filter((w) => /^[A-Z]{3,}$/.test(w) && !/^(URL|USA|USB|API|CEO|CTO|AI|PDF|HTML|CSS|SQL|AWS|GPU|CPU)$/.test(w)).length;

  const openerCounts = new Map<string, number>();
  let transitionOpeners = 0;
  let questions = 0;
  let exclaims = 0;
  for (const s of sentences) {
    const ws = words(s);
    const first = ws[0].toLowerCase().replace(/\u2019/g, "'").replace(/[^a-z']/g, '');
    const second = (ws[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    openerCounts.set(first, (openerCounts.get(first) || 0) + 1);
    if (TRANSITIONS.has(first) || TRANSITION_PAIRS.has(`${first} ${second}`)) transitionOpeners++;
    if (/\?["'\u201d\u2019)]*$/.test(s)) questions++;
    if (/!["'\u201d\u2019)]*$/.test(s)) exclaims++;
  }
  const openers = [...openerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word, n]) => ({ word, share: round(n / S, 3) }));

  const freq = new Map<string, number>();
  for (const w of allWords) {
    const k = w.toLowerCase().replace(/^['\u2019]+|['\u2019]+$/g, '');
    if (k.length < 3 || STOP.has(k) || /^\d/.test(k) || k === 'url' || k === 'code') continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const signature = [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, n]) => ({ word, per_1k: per1k(n) }));

  return {
    words: allWords.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    sentence_len: {
      mean: round(mean),
      sd: round(sd),
      median,
      short_share: round(lens.filter((l) => l <= 8).length / S, 3),
      long_share: round(lens.filter((l) => l >= 30).length / S, 3),
    },
    paragraph_sentences: paragraphs.length ? round(sentences.length / paragraphs.length) : 0,
    word_len: allWords.length ? round(letters / allWords.length) : 0,
    long_word_share: round(longWords / W, 3),
    ttr: round(ttr, 2),
    per_1k: {
      semicolons: per1k(count(/;/g)),
      colons: per1k(count(/:(?!\/\/)/g)),
      em_dashes: per1k(count(/\u2014|(?<=\w)--(?=\w)|\s--\s/g)),
      en_dashes: per1k(count(/\u2013/g)),
      parentheses: per1k(count(/\(/g)),
      exclamations: per1k(count(/!/g)),
      questions: per1k(count(/\?/g)),
      quotes: per1k(count(/["\u201c]/g)),
      ellipses: per1k(count(/\.\.\.|\u2026/g)),
      contractions: per1k(contractions),
      first_person: per1k(firstPerson),
      second_person: per1k(secondPerson),
      numbers: per1k(numbers),
      adverbs_ly: per1k(adverbs),
      caps_words: per1k(caps),
    },
    openers,
    transition_openers_share: round(transitionOpeners / S, 3),
    closers: { question_share: round(questions / S, 3), exclamation_share: round(exclaims / S, 3) },
    signature_words: signature,
    markdown,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtN = (n: number) => n.toLocaleString('en-US');

export function formatMetrics(m: VoiceMetrics, samples?: number): string {
  const k = m.per_1k;
  const lines: string[] = [];
  lines.push(`Words ${fmtN(m.words)}${samples ? ` in ${samples} sample${samples === 1 ? '' : 's'}` : ''}; ${fmtN(m.sentences)} sentences; ${fmtN(m.paragraphs)} paragraphs.`);
  lines.push(`Sentence length: mean ${m.sentence_len.mean} words (sd ${m.sentence_len.sd}, median ${m.sentence_len.median}); ${pct(m.sentence_len.short_share)} short (8 words or fewer), ${pct(m.sentence_len.long_share)} long (30 or more).`);
  lines.push(`Paragraphs: ${m.paragraph_sentences} sentences on average.`);
  lines.push(`Vocabulary: average word ${m.word_len} letters; ${pct(m.long_word_share)} long words (7+ letters); type-token ratio ${m.ttr} over the first 2,000 words.`);
  lines.push(
    `Per 1,000 words: semicolons ${k.semicolons}, colons ${k.colons}, em dashes ${k.em_dashes}, en dashes ${k.en_dashes}, parentheses ${k.parentheses}, exclamation marks ${k.exclamations}, question marks ${k.questions}, quotation marks ${k.quotes}, ellipses ${k.ellipses}, contractions ${k.contractions}, first person ${k.first_person}, second person ${k.second_person}, numbers ${k.numbers}, -ly adverbs ${k.adverbs_ly}, ALL-CAPS words ${k.caps_words}.`
  );
  lines.push(`Sentence openers: ${m.openers.map((o) => `"${o.word}" ${pct(o.share)}`).join(', ') || 'none'}; ${pct(m.transition_openers_share)} of sentences open with a transition word (However, Also, Additionally, But, So, For example).`);
  lines.push(`Sentences ending with a question: ${pct(m.closers.question_share)}; with an exclamation: ${pct(m.closers.exclamation_share)}.`);
  lines.push(`Signature words (frequent, not function words): ${m.signature_words.map((s) => `${s.word} (${s.per_1k} per 1,000)`).join(', ') || 'none stand out'}.`);
  lines.push(`Formatting: ${pct(m.markdown.bullets_share)} of lines are bullets or numbered items; ${m.markdown.headings} headings; ${m.markdown.bold} bold spans.`);
  return lines.join('\n');
}

// ── The voice document (gateway) ───────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const SYSTEM = `You are a senior editor who describes a writer's voice from measurements and excerpts, precisely enough that another writer, or an Ai, could reproduce it and a reviewer could check a draft against it. You write plain English. You describe only what the evidence shows: never guess at the writer's character, background, beliefs or politics, and never praise or judge the writing. Never use an em dash or en dash character.`;

export function excerpts(texts: Array<{ name: string; text: string }>, total = 7000): string {
  const out: string[] = [];
  let used = 0;
  const perText = texts.length >= 3 ? 1 : texts.length === 2 ? 2 : 3;
  const sliceLen = Math.max(600, Math.min(1500, Math.floor(total / Math.max(1, Math.min(texts.length, 6) * perText))));
  for (const t of texts.slice(0, 6)) {
    const clean = cleanForProse(t.text).prose.replace(/\n{2,}/g, '\n\n').trim();
    const points = perText === 1 ? [0] : perText === 2 ? [0, 0.55] : [0, 0.4, 0.8];
    for (const p of points) {
      if (used >= total) break;
      let start = Math.floor(clean.length * p);
      if (start > 0) {
        const nl = clean.indexOf('\n\n', start);
        start = nl > 0 && nl - start < 800 ? nl + 2 : start;
      }
      const piece = clean.slice(start, start + sliceLen).trim();
      if (!piece) continue;
      out.push(`[${t.name}${p ? `, from ${pct(p)} in` : ''}]\n${piece}`);
      used += piece.length;
    }
  }
  return out.join('\n\n');
}

function learnPrompt(who: string, metrics: string, excerptText: string): string {
  return `Describe ${who}'s writing voice and write the rules an Ai must follow to draft in it.

MEASUREMENTS (from the writer's own samples)
${metrics}

EXCERPTS
${excerptText}

Reply with one JSON object and nothing else, no code fence:
{
  "name": "two to five words naming this voice, for example \\"plain engineer voice\\" or \\"warm direct founder voice\\"",
  "description": "120 to 220 words. Cover: rhythm (sentence and paragraph length and how much they vary), register and tone, point of view and how the reader is addressed, how sentences open and close, punctuation the writer uses and punctuation the writer never uses, vocabulary level and signature words, formatting habits (bullets, headings, bold), and what the writer never does. Every claim must trace to a measurement or an excerpt.",
  "rules": [{"subject": "voice_<snake_case_label>", "content": "one rule of 90 to 220 characters, starting with ALWAYS or NEVER, concrete enough to check in a draft; cite the measurement when one supports it"}],
  "sample_sentence": "one sentence, written new, that this writer could have written"
}
Write 8 to 12 rules covering: sentence rhythm; paragraph length; how sentences open; the punctuation marks the writer never uses (a mark at 0.0 per 1,000 words is a fact, make it a NEVER); the marks the writer does use; contractions; person and address; vocabulary level and signature words; formatting; and anything the excerpts show that the measurements miss. Rules are about how drafts written FOR this person must read. Never write a rule about what the person believes or about the subject matter. Keep every string free of em dashes and en dashes.`;
}

export interface VoiceDoc {
  name: string;
  description: string;
  rules: Array<{ subject: string; content: string }>;
  sample_sentence?: string;
}

export function parseVoiceReply(text: string): VoiceDoc {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the voice reply held no JSON object');
  const raw = JSON.parse(stripped.slice(start, end + 1)) as Partial<VoiceDoc>;
  const name = tidy(String(raw.name || 'own voice')).replace(/\s+/g, ' ').trim().slice(0, 60);
  const description = tidy(String(raw.description || '')).replace(/\s+/g, ' ').trim();
  if (description.length < 40) throw new Error('the voice reply had no description');
  const seen = new Set<string>();
  const rules: VoiceDoc['rules'] = [];
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!r || typeof r.content !== 'string') continue;
    const content = tidy(r.content).replace(/\s+/g, ' ').trim();
    if (content.length < 20) continue;
    let subject = String(r.subject || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!subject.startsWith('voice_')) subject = `voice_${subject || 'rule'}`;
    subject = subject.slice(0, 60);
    let unique = subject;
    for (let i = 2; seen.has(unique); i++) unique = `${subject}_${i}`;
    seen.add(unique);
    rules.push({ subject: unique, content });
    if (rules.length === 12) break;
  }
  if (rules.length < 4) throw new Error(`the voice reply had only ${rules.length} usable rules`);
  const sample = typeof raw.sample_sentence === 'string' ? tidy(raw.sample_sentence).trim() : undefined;
  return { name, description, rules, sample_sentence: sample };
}

// ── Storage ───────────────────────────────────────────────────

export type VoiceScope = 'global' | 'project';

export interface VoiceProfile {
  name: string;
  who: string;
  description: string;
  rules: Array<{ subject: string; content: string }>;
  metrics: VoiceMetrics;
  scope: VoiceScope;
  project_id: string;
  samples: string[];
  learned_at: string;
  version: string;
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function cachePath(scope: VoiceScope, projectId: string): string {
  return join(FLAG_DIR, scope === 'global' ? 'voice-global.json' : `voice-${safeId(projectId)}.json`);
}

function writeCache(p: VoiceProfile): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(cachePath(p.scope, p.project_id), JSON.stringify(p, null, 2), 'utf-8');
  } catch {
    /* the memories are the record; the cache only saves a fetch */
  }
}

function readCache(scope: VoiceScope, projectId: string): VoiceProfile | null {
  try {
    const f = cachePath(scope, projectId);
    if (!existsSync(f)) return null;
    const p = JSON.parse(readFileSync(f, 'utf-8')) as VoiceProfile;
    return p && p.metrics && p.description ? p : null;
  } catch {
    return null;
  }
}

/** The text of the voice_profile rule: what every session of every connected Ai reads. */
export function profileRuleContent(who: string, doc: VoiceDoc): string {
  const head = `ALWAYS write in ${who}'s own voice when drafting anything for them (messages, posts, documents, replies, papers): the "${doc.name}". ${doc.description}`;
  const tail = ` Before handing back a draft longer than a paragraph, check it with voice_check and fix what it flags.\nGUARD: off`;
  return head.slice(0, 1800 - tail.length) + tail;
}

/** The intent document the review judges a draft against. */
export function voiceIntent(p: Pick<VoiceProfile, 'who' | 'name' | 'description' | 'rules'>): string {
  const rules = p.rules.map((r) => `- ${r.content.replace(/\nGUARD:.*$/i, '')}`).join('\n');
  const doc = `# Voice: ${p.name} (${p.who})

## Purpose
Every draft written for ${p.who} must read as if ${p.who} wrote it. This document describes that voice, and a draft is reviewed against it for voice only.

## The voice
${p.description}

## Invariants
${rules}

## Out of scope
The facts, argument, length and structure the draft was asked to carry are not judged here. Only whether the words sound like ${p.who}.`;
  return doc.length > 6000 ? doc.slice(0, 5990) + '\n...' : doc;
}

interface MemoryRow {
  id?: number;
  subject?: string;
  content?: string;
  scope?: string;
  memory_type?: string;
}

async function listVoiceMemories(storage: StorageBackend, scope: VoiceScope, projectId: string): Promise<MemoryRow[]> {
  const params: Record<string, unknown> = scope === 'global' ? { scope: 'global', tags: 'voice', limit: 100 } : { project_id: projectId, tags: 'voice', limit: 100 };
  const data = (await storage.listMemories(params)) as { memories?: MemoryRow[] };
  return (data.memories || []).filter((m) => typeof m.subject === 'string' && m.subject.startsWith('voice_') && (scope === 'global' ? m.scope === 'global' || !m.scope : m.scope !== 'global'));
}

/** Rebuild a profile from the memories when there is no local cache (another machine, or remote mode). */
export async function loadProfile(storage: StorageBackend, scope: VoiceScope, projectId: string, useCache = true): Promise<VoiceProfile | null> {
  if (useCache) {
    const c = readCache(scope, projectId);
    if (c) return c;
  }
  const rows = await listVoiceMemories(storage, scope, projectId);
  const metricsRow = rows.find((m) => m.subject === 'voice_metrics');
  const profileRow = rows.find((m) => m.subject === 'voice_profile');
  if (!metricsRow || !profileRow || !metricsRow.content || !profileRow.content) return null;
  const j = metricsRow.content.indexOf('JSON: ');
  if (j < 0) return null;
  let metrics: VoiceMetrics;
  try {
    metrics = JSON.parse(metricsRow.content.slice(j + 6)) as VoiceMetrics;
  } catch {
    return null;
  }
  const whoMatch = /^ALWAYS write in (.+?)'s own voice/.exec(profileRow.content);
  const nameMatch = /: the "([^"]+)"\. /.exec(profileRow.content);
  const description = profileRow.content
    .replace(/^ALWAYS write in .+?'s own voice[^:]*: the "[^"]+"\. /, '')
    .replace(/ Before handing back a draft[\s\S]*$/, '')
    .trim();
  const profile: VoiceProfile = {
    name: nameMatch ? nameMatch[1] : 'own voice',
    who: whoMatch ? whoMatch[1] : 'this person',
    description,
    rules: rows.filter((m) => m.subject !== 'voice_profile' && m.subject !== 'voice_metrics' && m.memory_type !== 'context').map((m) => ({ subject: m.subject || 'voice_rule', content: (m.content || '').replace(/\nGUARD:.*$/i, '') })),
    metrics,
    scope,
    project_id: projectId,
    samples: [],
    learned_at: '',
    version: VERSION,
  };
  if (useCache) writeCache(profile);
  return profile;
}

// ── Learn ─────────────────────────────────────────────────────

export interface LearnOptions {
  apiKey: string;
  cwd: string;
  files: string[];
  who?: string;
  scope?: VoiceScope;
  model?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface LearnResult {
  profile: VoiceProfile | null;
  metrics: VoiceMetrics;
  stored: number;
  archived: number;
  dryRun: boolean;
}

export async function learn(opt: LearnOptions): Promise<LearnResult> {
  const log = opt.log || (() => {});
  const scope: VoiceScope = opt.scope || 'global';
  const projectId = projectIdFor(opt.cwd);
  const who = (opt.who || '').trim() || 'this person';
  const model = opt.model || DEFAULT_MODEL;

  log(`[1/4] reading ${opt.files.length} file${opt.files.length === 1 ? '' : 's'}`);
  const texts: Array<{ name: string; text: string }> = [];
  for (const f of opt.files) {
    const path = resolve(opt.cwd, f);
    if (!existsSync(path)) throw new Error(`${f}: no such file`);
    const text = await extractText(path);
    const n = words(text).length;
    log(`  ${basename(path)}: ${fmtN(n)} words`);
    if (n >= 40) texts.push({ name: basename(path), text });
    else log(`  (skipped, under 40 words)`);
  }
  if (!texts.length) throw new Error('no usable samples (each file needs at least 40 words of the person\'s own writing)');

  log('[2/4] measuring');
  const metrics = measure(texts.map((t) => t.text).join('\n\n'));
  if (metrics.words < 300) throw new Error(`only ${metrics.words} words across the samples; the profile needs at least 300, and 1,500 or more gives a much better one`);
  if (metrics.words < 1500) log(`  note: ${fmtN(metrics.words)} words is enough to start; 1,500 or more gives a much better profile`);
  const metricsText = formatMetrics(metrics, texts.length);
  log(metricsText.split('\n').map((l) => '  ' + l).join('\n'));

  const excerptText = excerpts(texts);
  if (opt.dryRun) {
    log('');
    log('Dry run. The measurements above and these excerpts would be sent to the MSGR gateway, once, to write the voice document:');
    log(excerptText.split('\n').map((l) => '  ' + l).join('\n'));
    log('Nothing was sent and nothing was stored.');
    return { profile: null, metrics, stored: 0, archived: 0, dryRun: true };
  }

  log(`[3/4] writing the voice document (${model})`);
  const reply = await gatewayChat(opt.apiKey, projectId, model, SYSTEM, learnPrompt(who, metricsText, excerptText), 2500);
  const doc = parseVoiceReply(reply);
  log(`  "${doc.name}": ${doc.rules.length} rules`);

  log(`[4/4] storing as ${scope === 'global' ? 'global rules (every project)' : `rules for project ${projectId}`}`);
  const storage = new CloudStorage(opt.apiKey);
  let archived = 0;
  try {
    const previous = await listVoiceMemories(storage, scope, projectId);
    for (const m of previous) {
      if (typeof m.id !== 'number') continue;
      try {
        await storage.deleteMemory(m.id);
        archived++;
      } catch {
        /* a leftover is visible in voice show and harmless */
      }
    }
    if (archived) log(`  moved ${archived} earlier voice memor${archived === 1 ? 'y' : 'ies'} to the trash`);
  } catch {
    /* first profile, or listing failed; saving still proceeds */
  }

  const when = new Date().toISOString().slice(0, 10);
  let stored = 0;
  const save = async (body: Record<string, unknown>) => {
    try {
      await storage.saveMemory({ scope, project_id: projectId, ...body });
      stored++;
    } catch (e) {
      log(`  ! ${body.subject}: ${(e as Error).message}`);
    }
  };
  await save({ memory_type: 'rule', category: 'voice', subject: 'voice_profile', importance: 10, tags: ['voice', 'voice-profile'], content: profileRuleContent(who, doc) });
  for (const r of doc.rules) {
    await save({ memory_type: 'rule', category: 'voice', subject: r.subject, importance: 10, tags: ['voice', 'voice-rule'], content: `${r.content}\nGUARD: off` });
  }
  const metricsJson = JSON.stringify(metrics);
  await save({
    memory_type: 'context',
    category: 'voice',
    subject: 'voice_metrics',
    importance: 6,
    tags: ['voice', 'voice-metrics'],
    content: `Voice metrics for ${who} ("${doc.name}"), measured ${when} by cogmemai-mcp ${VERSION} from ${texts.map((t) => t.name).join(', ')}.\n${metricsText}\nJSON: ${metricsJson}`.slice(0, 9000),
  });
  log(`  memories: ${stored} stored`);
  try {
    await syncGuardRules(opt.apiKey, projectId);
  } catch {
    /* the next hook run syncs */
  }

  const profile: VoiceProfile = {
    name: doc.name,
    who,
    description: doc.description,
    rules: doc.rules,
    metrics,
    scope,
    project_id: projectId,
    samples: texts.map((t) => t.name),
    learned_at: when,
    version: VERSION,
  };
  writeCache(profile);
  return { profile, metrics, stored, archived, dryRun: false };
}

// ── Check ─────────────────────────────────────────────────────

export interface DriftFinding {
  severity: 'high' | 'medium' | 'low';
  text: string;
}

/** Compare a draft's measurements with the profile's. Deterministic, no network. */
export function drift(profile: VoiceMetrics, draft: VoiceMetrics, draftText?: string): { score: number; findings: DriftFinding[] } {
  const f: DriftFinding[] = [];
  let penalty = 0;
  const add = (severity: DriftFinding['severity'], text: string) => {
    f.push({ severity, text });
    penalty += severity === 'high' ? 15 : severity === 'medium' ? 8 : 4;
  };
  const p = profile.per_1k;
  const d = draft.per_1k;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const marks: Array<[keyof VoiceMetrics['per_1k'], string, string]> = [
    ['semicolons', 'semicolon', 'semicolons'],
    ['em_dashes', 'em dash', 'em dashes'],
    ['en_dashes', 'en dash', 'en dashes'],
    ['exclamations', 'exclamation mark', 'exclamation marks'],
    ['ellipses', 'ellipsis', 'ellipses'],
  ];
  for (const [key, one, many] of marks) {
    if (p[key] <= 0.3 && d[key] > 0) {
      const n = Math.round((d[key] * draft.words) / 1000) || 1;
      add('high', `uses ${plural(n, one, many)}; the writer uses none`);
    }
  }
  if (draft.words >= 60) {
    const diff = draft.sentence_len.mean - profile.sentence_len.mean;
    if (Math.abs(diff) > Math.max(5, 0.3 * profile.sentence_len.mean)) {
      add('medium', `sentences average ${draft.sentence_len.mean} words; the writer averages ${profile.sentence_len.mean} (${diff > 0 ? 'longer' : 'shorter'} than the voice)`);
    }
    if (profile.sentence_len.sd / Math.max(1, profile.sentence_len.mean) >= 0.45 && draft.sentence_len.sd / Math.max(1, draft.sentence_len.mean) < 0.25 && draft.sentences >= 6) {
      add('low', `sentence length barely varies (sd ${draft.sentence_len.sd}); the writer mixes short and long (sd ${profile.sentence_len.sd})`);
    }
  }
  if (draft.words >= 80) {
    if (p.contractions >= 8 && d.contractions === 0) add('medium', `no contractions; the writer uses about ${Math.round(p.contractions)} per 1,000 words`);
    if (p.contractions <= 1 && d.contractions >= 8) add('medium', `${Math.round(d.contractions)} contractions per 1,000 words; the writer almost never contracts`);
    if (p.first_person >= 15 && d.first_person === 0) add('low', `no first person; the writer uses I and we about ${Math.round(p.first_person)} times per 1,000 words`);
    if (p.first_person <= 2 && d.first_person >= 15) add('medium', `first person ${Math.round(d.first_person)} per 1,000 words; the writer stays out of the text`);
    if (p.second_person <= 2 && d.second_person >= 20) add('low', `addresses the reader as "you" ${Math.round(d.second_person)} times per 1,000 words; the writer rarely does`);
    if (Math.abs(draft.long_word_share - profile.long_word_share) > 0.08) {
      add('low', `${pct(draft.long_word_share)} long words against the writer's ${pct(profile.long_word_share)} (vocabulary ${draft.long_word_share > profile.long_word_share ? 'heavier' : 'lighter'} than the voice)`);
    }
    if (p.adverbs_ly <= 4 && d.adverbs_ly >= 12) add('low', `${Math.round(d.adverbs_ly)} -ly adverbs per 1,000 words; the writer uses about ${Math.round(p.adverbs_ly)}`);
  }
  if (draft.sentences >= 6) {
    if (profile.transition_openers_share >= 0.15 && draft.transition_openers_share === 0) add('low', `no sentence opens with a transition word; the writer starts ${pct(profile.transition_openers_share)} of sentences with one (However, Also, But, So)`);
    if (profile.transition_openers_share <= 0.05 && draft.transition_openers_share >= 0.3) add('low', `${pct(draft.transition_openers_share)} of sentences open with a transition word; the writer rarely does`);
  }
  if (draft.paragraphs >= 3 && Math.abs(draft.paragraph_sentences - profile.paragraph_sentences) > 2.5) {
    add('low', `paragraphs run ${draft.paragraph_sentences} sentences; the writer's run ${profile.paragraph_sentences}`);
  }
  if (profile.markdown.bullets_share === 0 && draft.markdown.bullets_share >= 0.3) add('low', 'written largely as bullets; the writer writes in paragraphs');
  if (draftText && draft.words >= 150 && profile.signature_words.length >= 5) {
    const used = new Set(words(draftText).map((w) => w.toLowerCase().replace(/^['\u2019]+|['\u2019]+$/g, '')));
    const top = profile.signature_words.slice(0, 8);
    if (!top.some((s) => used.has(s.word))) add('low', `none of the writer's frequent words appear (${top.map((s) => s.word).join(', ')})`);
  }
  return { score: Math.max(0, 100 - penalty), findings: f };
}

export interface CheckOptions {
  scope?: VoiceScope;
  projectId: string;
  min?: number;
  useCache?: boolean;
  who?: string;
}

export interface CheckResult {
  passed: boolean;
  min: number;
  profile: { name: string; who: string; scope: VoiceScope; rules: number } | null;
  local: { score: number; findings: DriftFinding[]; metrics: string } | null;
  review: { judged: boolean; coverage: number | null; violations: string[]; uncovered: string[]; summary: string; reason?: string } | null;
  note?: string;
}

export async function checkVoice(storage: StorageBackend, text: string, opt: CheckOptions): Promise<CheckResult> {
  const scope: VoiceScope = opt.scope || 'global';
  const min = typeof opt.min === 'number' && opt.min >= 0 && opt.min <= 100 ? opt.min : 80;
  const profile = await loadProfile(storage, scope, opt.projectId, opt.useCache !== false);
  if (!profile) {
    return { passed: false, min, profile: null, local: null, review: null, note: `No ${scope} voice profile${scope === 'project' ? ` for ${opt.projectId}` : ''}. Learn one from the person's own writing: cogmemai-mcp voice learn <files...>${scope === 'project' ? ' --project' : ''}` };
  }
  const draftMetrics = measure(text);
  const local = drift(profile.metrics, draftMetrics, text);
  const localOut = { score: local.score, findings: local.findings, metrics: formatMetrics(draftMetrics) };

  let review: CheckResult['review'] = null;
  if (storage.intentCheck) {
    const body = {
      project_id: `voice:${scope === 'global' ? 'global' : opt.projectId}`,
      work: `Draft written for ${profile.who}, to be judged for voice only (not for its facts or argument):\n\n${text.slice(0, 24_000)}`,
      intent: voiceIntent(profile),
      rules: false,
    };
    // The server reports a violation as {intent, change} (the line violated, what the draft did); older shapes carry rule and evidence.
    type Verdict = { judged?: boolean; reason?: string; summary?: string; covered?: string[]; uncovered?: string[]; violations?: Array<{ intent?: string; change?: string; rule?: string; evidence?: string; text?: string } | string>; coverage?: number | null };
    try {
      let r = (await storage.intentCheck(body)) as Verdict;
      // The judge's reply occasionally fails to parse on the server; one more try is cheap.
      if (r && r.judged === false && r.reason === 'unparseable') r = (await storage.intentCheck(body)) as Verdict;
      review = {
        judged: !!r.judged,
        coverage: typeof r.coverage === 'number' ? r.coverage : null,
        violations: (r.violations || []).map((v) => (typeof v === 'string' ? v : [v.intent || v.rule, v.change || v.evidence || v.text].filter(Boolean).join(': '))),
        uncovered: r.uncovered || [],
        summary: r.summary || '',
        reason: r.reason,
      };
    } catch (e) {
      review = { judged: false, coverage: null, violations: [], uncovered: [], summary: '', reason: (e as Error).message };
    }
  }
  const reviewOk = !review || !review.judged || ((review.coverage ?? 0) >= min && review.violations.length === 0);
  const passed = local.score >= min && reviewOk;
  let note: string | undefined;
  if (!storage.intentCheck) note = 'The judged review needs cloud or hybrid mode; only the local drift check ran.';
  else if (review && !review.judged) {
    const why = review.reason || '';
    note = /tier|plan|upgrade|free/i.test(why)
      ? 'The judged review runs on the paid tiers; the local drift check ran.'
      : `The judged review returned no verdict${why ? ` (${why})` : ''}; the local drift check ran. Run the check again for a verdict.`;
  }
  return { passed, min, profile: { name: profile.name, who: profile.who, scope, rules: profile.rules.length }, local: localOut, review, note };
}

// ── CLI ───────────────────────────────────────────────────────

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

const VALUE_FLAGS = new Set(['--name', '--path', '--model', '--min']);

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function readDraft(arg: string | undefined, cwd: string): Promise<string> {
  if (!arg || arg === '-') {
    try {
      return readFileSync(0, 'utf-8');
    } catch {
      return '';
    }
  }
  const path = resolve(cwd, arg);
  if (!existsSync(path)) throw new Error(`${arg}: no such file`);
  return extractText(path);
}

export function renderCheck(r: CheckResult): string {
  const out: string[] = [];
  if (!r.profile) return r.note || 'No voice profile.';
  out.push(`Voice: "${r.profile.name}" (${r.profile.who}, ${r.profile.scope}, ${r.profile.rules} rules). Threshold ${r.min}.`);
  if (r.local) {
    out.push(`Drift check: ${r.local.score}/100${r.local.findings.length ? '' : ', nothing stands out'}`);
    for (const f of r.local.findings) out.push(`  ${f.severity}: ${f.text}`);
  }
  if (r.review && r.review.judged) {
    out.push(`Review: coverage ${r.review.coverage ?? 'n/a'}, ${r.review.violations.length} violation${r.review.violations.length === 1 ? '' : 's'}`);
    if (r.review.summary) out.push(`  ${r.review.summary}`);
    for (const v of r.review.violations) out.push(`  violation: ${v}`);
    for (const u of r.review.uncovered) out.push(`  uncovered: ${u}`);
  }
  if (r.note) out.push(r.note);
  out.push('');
  out.push(r.passed ? 'PASSED: this reads like the writer.' : 'FAILED: fix what is flagged above, then run the check again.');
  return out.join('\n');
}

export async function runVoiceCli(args: string[], resolveKey: () => string): Promise<void> {
  const sub = (args[0] || 'help').toLowerCase();
  const usage = () => {
    console.log('Usage:');
    console.log('  cogmemai-mcp voice learn <files...> [--name "Scott"] [--project] [--path DIR] [--model ID] [--dry-run]');
    console.log('  cogmemai-mcp voice check <file|-> [--min 80] [--project] [--path DIR]');
    console.log('  cogmemai-mcp voice show [--project] [--path DIR]');
    console.log('');
    console.log('learn reads writing the person wrote themselves (.txt, .md, .html, .docx, .pdf), measures it here, and stores a voice');
    console.log('profile plus 8 to 12 rules as rule memories, so every connected Ai writes in that voice. Global by default (the');
    console.log('person); --project makes it a brand voice for this project only. check measures a draft against the profile and');
    console.log('has the review judge it against the voice document; it passes at the threshold with no violations.');
  };
  if (sub === 'help' || sub === '--help' || sub === '-h') return usage();

  const key = resolveKey();
  if (!key) {
    console.error('No CogmemAi API key found. Run `npx cogmemai-mcp setup` first.');
    process.exit(1);
  }
  const cwd = opt(args, '--path') || process.cwd();
  const scope: VoiceScope = args.includes('--project') ? 'project' : 'global';

  if (sub === 'learn') {
    const files = positional(args);
    if (!files.length) {
      console.error('Name the files: cogmemai-mcp voice learn notes.md email.txt paper.docx');
      process.exit(1);
    }
    const r = await learn({ apiKey: key, cwd, files, who: opt(args, '--name') || undefined, scope, model: opt(args, '--model') || undefined, dryRun: args.includes('--dry-run'), log: (l) => console.log(l) });
    if (r.dryRun || !r.profile) return;
    console.log('');
    console.log(`Voice: "${r.profile.name}"`);
    console.log(r.profile.description);
    console.log('');
    console.log('Rules:');
    for (const rule of r.profile.rules) console.log(`  - ${rule.content}`);
    console.log('');
    console.log(`Stored ${r.stored} memories (${scope === 'global' ? 'global: every project, every connected Ai' : `project ${r.profile.project_id}`}). Every session now loads the profile and the rules.`);
    console.log('Check a draft: cogmemai-mcp voice check draft.md    (or pipe text in with -)');
    return;
  }

  if (sub === 'check') {
    const files = positional(args);
    const text = await readDraft(files[0], cwd);
    if (words(text).length < 20) {
      console.error('The draft needs at least 20 words. Pass a file, or pipe text in and use - as the file name.');
      process.exit(1);
    }
    const minRaw = opt(args, '--min');
    const min = minRaw ? Number(minRaw) : 80;
    const storage = new CloudStorage(key);
    const r = await checkVoice(storage, text, { scope, projectId: projectIdFor(cwd), min: Number.isFinite(min) ? min : 80 });
    console.log(renderCheck(r));
    // exitCode rather than process.exit: on Windows, exiting while the HTTP client still holds a
    // handle trips a libuv assertion (UV_HANDLE_CLOSING) and the shell sees 127 instead of 1.
    if (!r.profile) process.exitCode = 2;
    else if (!r.passed) process.exitCode = 1;
    return;
  }

  if (sub === 'show') {
    const storage = new CloudStorage(key);
    const p = await loadProfile(storage, scope, projectIdFor(cwd));
    if (!p) {
      console.log(`No ${scope} voice profile${scope === 'project' ? ` for ${projectIdFor(cwd)}` : ''}. Learn one: cogmemai-mcp voice learn <files...>${scope === 'project' ? ' --project' : ''}`);
      process.exitCode = 2;
      return;
    }
    console.log(`Voice: "${p.name}" for ${p.who} (${p.scope}${p.scope === 'project' ? `: ${p.project_id}` : ''}${p.learned_at ? `, learned ${p.learned_at}` : ''}${p.samples.length ? ` from ${p.samples.join(', ')}` : ''})`);
    console.log('');
    console.log(p.description);
    console.log('');
    console.log(`Rules (${p.rules.length}):`);
    for (const r of p.rules) console.log(`  - ${r.content}`);
    console.log('');
    console.log('Measured:');
    console.log(formatMetrics(p.metrics).split('\n').map((l) => '  ' + l).join('\n'));
    return;
  }

  usage();
}
