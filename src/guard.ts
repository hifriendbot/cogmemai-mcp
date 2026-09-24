/**
 * CogmemAi Guard: the decision engine.
 *
 * Pure functions, no I/O. Given a shell command and the rules this project
 * remembers, decide whether the command is safe to run unattended. The hook
 * and CLI plumbing lives in guard-hooks.ts; this file is what the tests
 * exercise directly.
 *
 * Design rules, in priority order:
 *
 * 1. FAIL OPEN. Anything unparseable is allowed. A guard that stalls a
 *    session gets uninstalled, and then it protects nobody.
 * 2. STOP MEANS STOP. An "ask" verdict is inert for anyone whose settings
 *    carry a blanket `Bash` entry in permissions.allow: the command is
 *    already approved, so no prompt is raised and the warning is never seen.
 *    Destructive operations are therefore denied outright, and every denial
 *    names the deliberate path forward, usually "run it yourself".
 * 3. JUDGE STRUCTURE, NOT DATA. Quoted strings and heredoc bodies are
 *    stripped before the structural rules run, so echoing a dangerous
 *    command into a notes file is not the same as running it.
 * 4. JUDGE WHAT WILL ACTUALLY RUN. The payload of `ssh host "..."`,
 *    `bash -c "..."` and a heredoc fed to a shell executes on the far side
 *    exactly as written, so it is judged as if typed directly.
 * 5. NO NETWORK. This runs before every shell command. Remembered rules are
 *    read from a local cache that the session-start hook keeps fresh.
 *
 * Every static rule traces to an incident that actually happened. The
 * comments say which, so nobody simplifies a rule without knowing its cost.
 */

export type Decision = 'deny' | 'ask';

export interface Verdict {
  decision: Decision;
  reason: string;
  rule: string;
}

/** A rule compiled from a CogmemAi rule memory. */
export interface MemoryRule {
  id: number;
  subject: string;
  /** Regex source, matched case-insensitively against the command skeleton. */
  pattern: string;
  /** 'explicit' came from a `GUARD:` line; 'derived' from a backticked command in a NEVER sentence. */
  source: 'explicit' | 'derived';
  /** The sentence shown to the user when the rule fires. */
  message: string;
}

// Paths that are safe to delete recursively: scratch space, build output,
// dependency trees.
const DISPOSABLE = /(\/tmp\/|\\temp\\|\/temp\/|scratchpad|node_modules|\.next|\/build\/|\\build\\|dist\/|\.cache|AppData\\Local\\Temp)/i;

// Destructive SQL verbs. Presence alone is not damning; context decides.
const SQL_DESTRUCTIVE = /\b(DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE)|TRUNCATE|UPDATE\s+\w+\s+SET)\b/i;

// A database client invocation: the statement is aimed at a real database
// rather than living in a string in some file.
const DB_CLIENT = /\b(wp\s+db\s+query|wp\s+db\s+cli|mysql\b|mariadb\b|psql\b|sqlite3\b)/i;

// Server-wide worker processes. Killing these by name on a shared host aborts
// every in-flight request on every site the account serves.
const SHARED_WORKERS = /\b(pkill|killall)\b[^|;&]*\b(lsphp|php-fpm|php_fpm|httpd|apache2|nginx|litespeed|lsws|mysqld|mariadbd|postgres)\b/i;

// Wrappers whose quoted argument is itself a command that will run somewhere.
const SSH_INVOCATION = /\bssh\s+(?:-[a-zA-Z]\s*\S*\s+)*(?:\S+@)?[\w.\-]+\s+/g;
const SHELL_DASH_C = /\b(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c[a-zA-Z]*\s+/g;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1/g;

const MAX_DEPTH = 3;

/** Remove quoted literals and heredoc bodies so rules judge shell structure, not data. */
export function stripQuoted(command: string): string {
  let out = command.replace(HEREDOC, ' ');
  out = out.replace(/'[^']*'/g, ' ');
  out = out.replace(/"[^"]*"/g, ' ');
  return out;
}

/** The contents of the quoted string that starts `rest`, or null. */
function quotedPayload(rest: string): string | null {
  const q = rest[0];
  if (q !== "'" && q !== '"') return null;
  const end = rest.lastIndexOf(q);
  return end > 0 ? rest.slice(1, end) : null;
}

/**
 * Every command carried inside a wrapper, with a label for the denial text.
 * Only wrappers that appear in the unquoted skeleton count: an ssh inside an
 * echo string is data, not an invocation.
 */
export function unwrap(command: string, skeleton: string): Array<{ label: string; payload: string }> {
  const out: Array<{ label: string; payload: string }> = [];
  if (/\bssh\b/.test(skeleton)) {
    for (const m of command.matchAll(SSH_INVOCATION)) {
      const p = quotedPayload(command.slice(m.index! + m[0].length));
      if (p) out.push({ label: 'the remote command run over ssh', payload: p });
    }
  }
  if (/\b(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c/.test(skeleton)) {
    for (const m of command.matchAll(SHELL_DASH_C)) {
      const p = quotedPayload(command.slice(m.index! + m[0].length));
      if (p) out.push({ label: 'the command passed to a shell with -c', payload: p });
    }
  }
  // A heredoc fed to ssh or a shell is executed line by line on arrival.
  const firstLine = command.split('\n', 1)[0];
  if (firstLine.includes('<<') && /\b(ssh|bash|sh|zsh|dash)\b/.test(stripQuoted(firstLine))) {
    for (const m of command.matchAll(HEREDOC)) {
      out.push({ label: 'the script fed to a shell by heredoc', payload: m[2] });
    }
  }
  return out;
}

function staticRules(command: string, skeleton: string): Verdict | null {
  // Rule 1: never clobber a crontab. A crontab was destroyed three separate
  // times by `crontab -l | ... | crontab -` pipelines, each time silently
  // killing scheduled jobs network wide and stranding paid orders.
  if (/crontab\s+-\s*$|crontab\s+-\s*[;&|]|\|\s*crontab\s+-/.test(skeleton)) {
    return {
      decision: 'deny',
      rule: 'crontab-pipeline',
      reason:
        'Blocked: this rewrites an entire crontab from a pipeline. That has silently destroyed ' +
        'scheduled jobs before. Edit the specific line by hand, or run it yourself if you truly ' +
        'intend to replace the whole file.',
    };
  }

  // Rule 2: destructive SQL against a live database. A scoped DELETE that
  // looked careful still destroyed real voter records that could not be
  // recovered. A WHERE clause is not proof of safety.
  const sql = SQL_DESTRUCTIVE.exec(command);
  if (sql && DB_CLIENT.test(skeleton)) {
    const verb = sql[1].toUpperCase().replace(/\s+/g, ' ');
    const scoped = /\bWHERE\b/i.test(command);
    const detail = scoped
      ? 'It is scoped with WHERE, which is not by itself proof it is safe: a scoped DELETE has destroyed real production rows before.'
      : 'It has no WHERE clause, so it applies to every row in the table.';
    return {
      decision: 'deny',
      rule: 'destructive-sql',
      reason:
        `Blocked: ${verb} against a live database. ${detail} Run the equivalent SELECT first to ` +
        'see exactly what it matches. If the change is correct and intended, run it yourself so the ' +
        'decision has a human behind it.',
    };
  }

  // Rule 3: recursive delete outside disposable paths.
  if (/\brm\b.*-[a-zA-Z]*r/i.test(skeleton)) {
    const m = /rm\s+(?:-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*[fF]?[a-zA-Z]*\s+(\S+)/.exec(skeleton);
    const target = m ? m[1] : '';
    if (!DISPOSABLE.test(target || skeleton)) {
      return {
        decision: 'deny',
        rule: 'recursive-delete',
        reason:
          'Blocked: recursive delete outside temp, build, or dependency directories, so anything ' +
          'removed may not be recoverable. Delete the specific paths you mean, or run it yourself ' +
          'if you intend to remove the whole tree.',
      };
    }
  }

  // Rule 4: force-push to a shared branch.
  if (/git\s+push\b/.test(skeleton) && /(--force(?!-with-lease)|\s-f\b)/.test(skeleton)) {
    if (/\b(main|master|prod|production)\b/.test(skeleton)) {
      return {
        decision: 'deny',
        rule: 'force-push',
        reason:
          'Blocked: force-push to a shared branch can overwrite commits that exist only on the ' +
          'remote. Use --force-with-lease, which refuses when the remote moved, or run the push yourself.',
      };
    }
  }

  // Rule 5: piping the internet into a shell.
  if (/(curl|wget)[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|python|node)\b/.test(skeleton)) {
    return {
      decision: 'deny',
      rule: 'curl-pipe-shell',
      reason:
        'Blocked: this pipes a downloaded script straight into an interpreter, so the contents are ' +
        'executed without ever being read. Download it, read it, then run it.',
    };
  }

  // Rule 6: killing shared server workers by name. An opcache "flush" via
  // `pkill lsphp` on a shared LSAPI pool aborted every in-flight request on
  // every site the account serves, twice in one afternoon; shutdown handlers
  // never ran, a build lock stayed wedged, and the killed API calls were
  // still billed.
  if (SHARED_WORKERS.test(skeleton)) {
    return {
      decision: 'deny',
      rule: 'kill-shared-workers',
      reason:
        'Blocked: this kills shared server workers by name. On a shared host that aborts every ' +
        'in-flight request on every site, shutdown handlers never run, and any lock or paid API ' +
        'call in progress is lost. To flush opcache, hit the site\'s opcache-bust script or wait 60 ' +
        'to 120 seconds for it to revalidate. If a process really must die, run the kill yourself.',
    };
  }

  return null;
}

function memoryRules(skeleton: string, rules: MemoryRule[]): Verdict | null {
  for (const r of rules) {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, 'i');
    } catch {
      continue;
    }
    if (re.test(skeleton)) {
      const label = r.subject ? ` (${r.subject})` : '';
      return {
        decision: 'deny',
        rule: `memory:${r.id}`,
        reason:
          `Blocked by a rule this project remembers${label}: ${r.message} ` +
          'If this is intended, run it yourself, or remove the rule with delete_rule.',
      };
    }
  }
  return null;
}

/**
 * Decide whether a command may run unattended. Returns null to stay silent
 * and allow. `rules` are the remembered rules for this project, already
 * compiled by compileMemoryRules and cached locally.
 */
export function decide(command: string, rules: MemoryRule[] = [], depth = 0): Verdict | null {
  const skeleton = stripQuoted(command);

  const v = staticRules(command, skeleton) || memoryRules(skeleton, rules);
  if (v) return v;

  if (depth < MAX_DEPTH) {
    for (const { label, payload } of unwrap(command, skeleton)) {
      const inner = decide(payload, rules, depth + 1);
      if (inner) {
        return { ...inner, reason: `Inside ${label}: ${inner.reason}` };
      }
    }
  }
  return null;
}

// ── Rules from memory ─────────────────────────────────────────

const PROHIBITION = /\b(NEVER|DO NOT|DON'T|MUST NOT|FORBIDDEN|HARD RULE|NOT ALLOWED)\b/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A literal command snippet as a whitespace-tolerant, word-bounded regex source. */
function snippetToPattern(snippet: string): string {
  const body = snippet
    .trim()
    .split(/\s+/)
    .map(escapeRegex)
    .join('\\s+');
  return `(?<![\\w-])${body}(?![\\w-])`;
}

function firstSentence(text: string): string {
  const flat = text.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
  const m = /^(.{20,230}?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1] : flat.slice(0, 230);
  return s.length < flat.length && !m ? s.replace(/\s\S*$/, '') + '...' : s;
}

/**
 * Turn rule memories into enforceable patterns.
 *
 * Two sources, in order of trust:
 *
 *  explicit  A line in the memory that reads `GUARD: <regex>`. The author
 *            chose the pattern, so it is used as written (case-insensitive).
 *  derived   A backticked command that follows NEVER, DO NOT, MUST NOT or
 *            similar in the same sentence. `NEVER RUN \`pkill -u www
 *            lsphp\`` becomes a rule with no one editing code. Snippets are
 *            only used when they are shaped like a command: a lowercase
 *            command name plus at least one argument, no `...`, no
 *            placeholders, no code punctuation. `GUARD: off` in a memory
 *            switches derivation off for it.
 *
 * Only memories whose memory_type is 'rule' are considered; ordinary
 * memories describe history and are not instructions.
 */
export function compileMemoryRules(memories: Array<Record<string, unknown>>): MemoryRule[] {
  const out: MemoryRule[] = [];
  const seen = new Set<string>();
  for (const m of memories) {
    if (!m || m.memory_type !== 'rule') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content) continue;
    const id = Number(m.id) || 0;
    const subject = typeof m.subject === 'string' ? m.subject : '';
    const message = firstSentence(content);

    // Explicit patterns. `GUARD: off` (or none) opts a memory out of
    // derivation entirely, for rules that describe a command without
    // meaning to ban it. Any explicit line also switches derivation off for
    // that memory: the author has said exactly what they want enforced.
    let explicitLines = 0;
    let optedOut = false;
    for (const line of content.split('\n')) {
      const g = /^\s*GUARD:\s*(.+?)\s*$/i.exec(line);
      if (!g) continue;
      const pattern = g[1];
      if (/^(off|none|disable|disabled)$/i.test(pattern)) {
        optedOut = true;
        continue;
      }
      try {
        new RegExp(pattern, 'i');
      } catch {
        continue;
      }
      explicitLines++;
      const key = `e:${pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, subject, pattern, source: 'explicit', message });
    }
    if (optedOut || explicitLines > 0) continue;

    // Derived patterns. The snippet must follow the prohibition inside the
    // same sentence ("NEVER RUN `x`", not "`x` is what we did, never again"),
    // and must be shaped like a command invocation: a lowercase command
    // name followed by at least one argument. Real rule memories carry
    // backticked identifiers, CSS and code fragments too, and a bare
    // `include_global` would have blocked every URL carrying that parameter.
    for (const sentence of content.split(/(?<=[.!?])\s+|\n+/)) {
      const p = PROHIBITION.exec(sentence);
      if (!p) continue;
      const after = sentence.slice(p.index + p[0].length);
      for (const bt of after.matchAll(/`([^`\n]{4,120})`/g)) {
        const snippet = bt[1].trim();
        if (snippet.includes('...') || /[<>{}()=;$]/.test(snippet)) continue;
        const tokens = snippet.split(/\s+/);
        if (tokens.length < 2) continue;
        if (!/^[a-z][a-z0-9_.\-]*$/.test(tokens[0])) continue;
        const pattern = snippetToPattern(snippet);
        const key = `d:${pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id, subject, pattern, source: 'derived', message });
      }
    }
  }
  // Explicit patterns first: the author chose them.
  out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'explicit' ? -1 : 1));
  return out;
}

// ── Log hygiene ───────────────────────────────────────────────

const REDACT = /((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+|(Bearer\s+)\S+|\b(cm_|sk-|ghp_|npm_)[A-Za-z0-9_\-]{6,}|(-p)(?=\S)\S+/gi;

/** Strip credentials from a command before it is written to the verdict log. */
export function redact(command: string): string {
  return command.replace(REDACT, (_m, a, b, c, d) => (a || b || c || d || '') + '[redacted]');
}


// ── Intent ────────────────────────────────────────────────────
//
// The intent document is the owner's plain-English source of truth for a
// project. Two things here are pure so they can be tested: pulling the
// enforceable sentences out of it, and turning the server's judgment into
// the few lines a person will actually read at the end of a turn.

export interface IntentViolation {
  intent: string;
  change: string;
}

export interface IntentCheckResult {
  judged: boolean;
  reason?: string;
  summary?: string;
  covered?: string[];
  uncovered?: string[];
  violations?: IntentViolation[];
  coverage?: number | null;
  proposed_update?: string;
}

/**
 * The section of an intent document whose sentences the guard may enforce.
 * A heading that reads like Invariants, Rules, Must, Never, Always,
 * Non-negotiables or Constraints opens it; the next heading closes it.
 * Everything else in the document is context for the judged review, not a
 * source of patterns.
 */
export function extractInvariants(markdown: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of String(markdown || '').split('\n')) {
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      inside = /\b(invariants?|rules?|must|never|always|non-negotiables?|constraints?)\b/i.test(h[1]);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

/** The intent document in the shape compileMemoryRules reads, or null when it has no invariants. */
export function intentAsRuleMemory(intent: { id?: number | string; content: string }): Record<string, unknown> | null {
  const invariants = extractInvariants(intent.content);
  if (!invariants) return null;
  return { id: Number(intent.id) || 0, memory_type: 'rule', subject: 'intent', content: invariants };
}

/** Shorten for one line, ending on a sentence when one falls in the second half of the budget. */
function trimTo(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n - 3);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= Math.floor(n / 2)) return head.slice(0, end + 1);
  return head.trimEnd() + '...';
}

/**
 * The lines a person reads at the end of a turn. A change the intent already
 * covers earns silence, like every other clean review. The summary appears
 * only when there is a conflict or a gap to act on, or on every judged turn
 * when `verbose` asks for it.
 */
export function formatIntentNotes(r: IntentCheckResult | null | undefined, verbose = false): string[] {
  if (!r || !r.judged) return [];
  const violations = (Array.isArray(r.violations) ? r.violations : []).filter((v) => v && (v.intent || v.change));
  const uncovered = (Array.isArray(r.uncovered) ? r.uncovered : []).filter((u) => typeof u === 'string' && u.trim());
  const notes: string[] = [];
  if (violations.length === 0 && uncovered.length === 0) {
    if (verbose && r.summary) notes.push(`Intent check: ${trimTo(r.summary, 300)} Your intent covers it.`);
    return notes;
  }
  if (r.summary) notes.push(`Intent check: ${trimTo(r.summary, 300)}`);
  for (const v of violations.slice(0, 2)) {
    notes.push(
      v.intent
        ? `Conflicts with your intent ("${trimTo(v.intent, 140)}"): ${trimTo(v.change, 200)}`
        : `Conflicts with your intent: ${trimTo(v.change, 200)}`
    );
  }
  if (uncovered.length) {
    notes.push(
      `Not in your intent yet: ${uncovered.slice(0, 3).map((u) => trimTo(u, 120)).join('; ')}. ` +
        'Say "add that to the intent" to record it, or ask for it to be reverted.'
    );
  }
  return notes;
}
