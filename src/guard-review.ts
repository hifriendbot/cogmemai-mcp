/**
 * CogmemAi Guard: end-of-turn review of the working tree.
 *
 * Deterministic checks for the mechanical mistakes an assistant makes when
 * nobody is watching, plus one question to CogmemAi: does this project
 * remember a landmine near the files that were just touched? That second
 * half is the part only a memory layer can do.
 *
 * Fail open, never modify anything, never call a language model.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';

const GIT_TIMEOUT = 8000;
const MAX_DIFF_BYTES = 400_000;

// Anything that looks like a live credential landing in tracked source.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_\-]{20,}/, 'an Anthropic API key'],
  [/\bSG\.[A-Za-z0-9_\-]{20,}/, 'a SendGrid API key'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bcm_[a-f0-9]{32,}/, 'a CogmemAi API key'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
  [/\b0x[a-fA-F0-9]{64}\b/, 'what looks like a raw private key'],
];

const VERSION_PATTERNS = [
  /["']version["']\s*:\s*["'](\d+\.\d+\.\d+)["']/, // json
  /\bversion\s*:\s*["'](\d+\.\d+\.\d+)["']/, // js/ts object
  /^\s*\*?\s*Version:\s*(\d+\.\d+\.\d+)\s*$/m, // wordpress header
  /__version__\s*=\s*["'](\d+\.\d+\.\d+)["']/, // python
  /\bVERSION\s*=\s*["'](\d+\.\d+\.\d+)["']/, // ts const
];

const VERSION_FILES = new Set(['package.json', 'server.json', 'composer.json', 'manifest.json']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.php', '.rb', '.go', '.java', '.cs', '.json', '.yml', '.yaml', '.env', '.sh']);

function git(args: string[], cwd: string): string {
  try {
    return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function changedFiles(root: string): { files: string[]; deleted: string[] } {
  const files: string[] = [];
  const deleted: string[] = [];
  for (const line of git(['status', '--porcelain'], root).split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).trim().replace(/^"|"$/g, '');
    if (status.includes('D')) deleted.push(path);
    else files.push(path);
  }
  return { files, deleted };
}

/**
 * Everything this turn introduced. `git diff` says nothing about brand new
 * files, which is where an assistant puts most new code, so untracked files
 * are read as well.
 */
function addedLines(root: string): string[] {
  const lines: string[] = [];
  for (const args of [['diff', '--unified=0'], ['diff', '--cached', '--unified=0']]) {
    for (const ln of git(args, root).slice(0, MAX_DIFF_BYTES).split('\n')) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) lines.push(ln.slice(1));
    }
  }
  for (const rel of git(['ls-files', '--others', '--exclude-standard'], root).split('\n').slice(0, 60)) {
    const path = rel.trim();
    if (!path || !CODE_EXT.has(extname(path).toLowerCase())) continue;
    const full = join(root, path);
    try {
      if (statSync(full).size > 200_000) continue;
      lines.push(...readFileSync(full, 'utf-8').split('\n'));
    } catch {
      /* unreadable */
    }
  }
  return lines;
}

function checkSecrets(lines: string[]): string[] {
  const hits: string[] = [];
  for (const ln of lines) {
    for (const [pat, what] of SECRET_PATTERNS) {
      if (pat.test(ln)) {
        if (!hits.includes(what)) hits.push(what);
        break;
      }
    }
  }
  return hits.slice(0, 3).map((h) => `Possible secret added to tracked source: ${h}.`);
}

/**
 * Release files that must agree but do not. A package once shipped with two
 * files still carrying the previous version, so the published build reported
 * the old, vulnerable number to its users.
 */
function checkVersionDrift(root: string, files: string[]): string[] {
  if (!files.some((f) => VERSION_FILES.has(basename(f)))) return [];
  const candidates = new Set<string>(VERSION_FILES);
  for (const f of files) if (/\.(ts|js|php|py|json)$/.test(f)) candidates.add(f);
  const found = new Map<string, string[]>();
  for (const rel of [...candidates].slice(0, 40)) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    let text = '';
    try {
      text = readFileSync(path, 'utf-8').slice(0, 200_000);
    } catch {
      continue;
    }
    for (const pat of VERSION_PATTERNS) {
      const m = pat.exec(text);
      if (m) {
        found.set(m[1], [...(found.get(m[1]) || []), rel]);
        break;
      }
    }
  }
  if (found.size > 1) {
    const parts = [...found.entries()].sort().map(([v, fs]) => `${v} in ${[...new Set(fs)].sort().slice(0, 3).join(', ')}`);
    return [
      'Version strings disagree across release files: ' +
        parts.join('; ') +
        '. A published package that reports the wrong version makes it impossible for users to tell whether they have the fix.',
    ];
  }
  return [];
}

function checkDeletions(root: string, deleted: string[]): string[] {
  const notes: string[] = [];
  const real = deleted.filter((d) => !/(\.bak|\/tmp\/|scratchpad|node_modules)/.test(d));
  if (real.length) notes.push(`Deleted ${real.length} tracked file(s): ${real.slice(0, 4).join(', ')}. Confirm that was intended.`);
  const m = /(\d+) insertions?\(\+\), (\d+) deletions?\(-\)/.exec(git(['diff', '--shortstat'], root));
  if (m) {
    const ins = parseInt(m[1], 10);
    const del = parseInt(m[2], 10);
    if (del > 150 && del > ins * 4) {
      notes.push(`This turn removed ${del} lines and added ${ins}. Large net deletions are how working behaviour disappears quietly.`);
    }
  }
  return notes;
}

/** A new function whose name already exists in the repo: the first symptom of a second implementation. */
function checkDuplicateDefinitions(root: string, lines: string[]): string[] {
  const names: string[] = [];
  for (const ln of lines) {
    const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w{3,})\s*\(/.exec(ln) || /^\s*def\s+([A-Za-z_]\w{3,})\s*\(/.exec(ln);
    if (m) names.push(m[1]);
  }
  const notes: string[] = [];
  for (const name of [...new Set(names)].slice(0, 12)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // --untracked matters: the duplicate usually arrives in a brand new file.
    const out = git(['grep', '-c', '--untracked', '-E', `"(function|def)\\s+${escaped}\\s*\\("`], root);
    let total = 0;
    for (const l of out.split('\n')) {
      const i = l.lastIndexOf(':');
      if (i > 0) total += parseInt(l.slice(i + 1), 10) || 0;
    }
    if (total > 1) {
      notes.push(`'${name}' is now defined in more than one place. If that is a second copy rather than a deliberate override, it will drift from the original.`);
    }
    if (notes.length >= 2) break;
  }
  return notes;
}

const RULE_SENTENCE = /\b(NEVER|ALWAYS|HARD RULE|STANDING RULE|must not|must be|do not|don't|gotcha|watch out|check these|before any|make sure)\b/i;
const GENERIC = new Set([
  'server', 'package', 'index', 'config', 'app', 'main', 'test', 'tests', 'build', 'utils', 'util', 'helper', 'helpers',
  'types', 'api', 'data', 'core', 'common', 'lib', 'readme', 'license', 'setup', 'script', 'scripts', 'style', 'styles',
  'hook', 'hooks', 'json', 'file', 'files',
]);

export interface ReviewOptions {
  apiKey: string;
  apiBase: string;
  timeoutMs: number;
  userAgent: string;
}

/**
 * Ask CogmemAi what it remembers about the area being edited. Semantic recall
 * always returns its best matches even when they are not about this code, so
 * a memory is shown only if it names the project or a touched file, and only
 * the one sentence that reads like a standing instruction.
 */
async function memoryLandmines(root: string, files: string[], opt: ReviewOptions): Promise<string[]> {
  if (!opt.apiKey || files.length === 0) return [];
  const project = basename(root);
  const message = `Working in the ${project} repository, editing these files: ${files.slice(0, 8).join(', ')}. What known rules, gotchas, or past incidents apply to this code?`;
  let data: { memories?: Array<{ content?: string }> } = {};
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opt.timeoutMs);
  try {
    const res = await fetch(`${opt.apiBase}/cogmemai/smart-recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opt.apiKey}`, 'User-Agent': opt.userAgent },
      body: JSON.stringify({ message, project_id: project, limit: 4 }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    data = (await res.json()) as typeof data;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }

  return pickLandmines(data.memories || [], files);
}

/**
 * Choose which recalled memories deserve a line on screen. Pure, so it is
 * testable against the memories that were wrongly shown.
 *
 * The bar is deliberately high, because every line here lands in the
 * user's chat: the sentence shown must itself name one of the files being
 * touched AND read like a standing instruction. Anchoring on the project
 * name was removed after a session in the main product repository surfaced
 * an email-verification policy and a note about an unrelated site's HTML,
 * both of which mentioned the project and neither of which concerned the
 * edit. A reviewer that adds reading without adding signal is noise, and
 * the person reading it has plenty to read already.
 */
export function pickLandmines(memories: Array<{ content?: string }>, files: string[]): string[] {
  const anchors = new Set<string>();
  for (const f of files.slice(0, 12)) {
    const lower = basename(f).toLowerCase();
    const stem = lower.replace(/\.[^.]+$/, '');
    if (GENERIC.has(stem) || stem.length <= 4) continue;
    anchors.add(lower);
    anchors.add(stem);
  }
  if (anchors.size === 0) return [];
  const anchorRe = new RegExp('(?<![A-Za-z0-9])(' + [...anchors].sort().map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])', 'i');

  const notes: string[] = [];
  for (const mem of memories.slice(0, 6)) {
    const content = mem && typeof mem.content === 'string' ? mem.content : '';
    if (!content) continue;
    const flat = content.replace(/\s+/g, ' ').replace(/[*_`#]+/g, '').trim();
    for (const sentence of flat.split(/(?<=[.!;])\s+/)) {
      let s = sentence.trim();
      if (s.length < 25 || !RULE_SENTENCE.test(s) || !anchorRe.test(s)) continue;
      if (s.length > 200) s = s.slice(0, 197).replace(/\s\S*$/, '') + '...';
      notes.push('Remembered: ' + s);
      break;
    }
    if (notes.length >= 1) break;
  }
  return notes;
}

/**
 * A fingerprint of the working tree's change set. When it matches the one
 * from the previous review, nothing new happened this turn and the review
 * stays silent: a tree that has carried three edited files all day must
 * not produce the same notes after every message.
 */
export function treeFingerprint(root: string): string {
  return [git(['status', '--porcelain'], root), git(['diff', '--shortstat'], root), git(['diff', '--cached', '--shortstat'], root)].join('|');
}

/** Review the working tree at `cwd`. Returns advisory notes; empty means a clean turn. */
export async function reviewWorkingTree(cwd: string, opt: ReviewOptions & { lastFingerprint?: string; onFingerprint?: (fp: string) => void }): Promise<string[]> {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  if (!root) return [];
  const { files, deleted } = changedFiles(root);
  if (files.length === 0 && deleted.length === 0) return [];
  const fp = treeFingerprint(root);
  if (opt.lastFingerprint && opt.lastFingerprint === fp) return [];
  if (opt.onFingerprint) opt.onFingerprint(fp);
  const lines = addedLines(root);
  const notes: string[] = [];
  notes.push(...checkSecrets(lines));
  notes.push(...checkVersionDrift(root, files));
  notes.push(...checkDeletions(root, deleted));
  notes.push(...checkDuplicateDefinitions(root, lines));
  notes.push(...(await memoryLandmines(root, files, opt)));
  return notes;
}
