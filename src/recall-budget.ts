/**
 * v3.32.0: a character budget for tool results.
 *
 * Long memories are returned in full by default, which is right for a single
 * lookup and expensive when an agent runs several broad searches in one
 * session: every result stays in the conversation and is re-read on each later
 * turn. With a budget, the best-ranked results still come back complete and
 * the rest are shortened to a snippet that carries its id, so nothing is
 * hidden and any of them can be read in full with one more call.
 *
 * Pure functions, no I/O. Off unless a budget is given: with budget 0 the
 * result object is returned untouched, the same reference.
 */

/** Length of a shortened memory. Memories at or under this are never cut. */
export const SNIPPET_CHARS = 400;

/** Related-memory previews on save responses are cut to this. */
export const RELATED_PREVIEW_CHARS = 300;

/** Upper bound for a budget, far above any real result. */
const MAX_BUDGET = 200000;

type Rec = Record<string, unknown>;

/**
 * The budget for one call. An explicit `max_chars` wins (0 means no limit);
 * otherwise the COGMEMAI_RECALL_MAX_CHARS environment variable; otherwise 0.
 * Anything unparseable or negative means no limit, never an error.
 */
export function resolveRecallBudget(param: number | undefined, envValue: string | undefined): number {
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_BUDGET) : 0);
  if (typeof param === 'number') return clamp(param);
  if (typeof envValue === 'string' && /^\s*\d+\s*$/.test(envValue)) return clamp(parseInt(envValue, 10));
  return 0;
}

function memoryId(m: Rec): number | null {
  const raw = m.id ?? m.memory_id;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : null;
}

export interface BudgetOutcome {
  /** The result to return. Identical to the input when nothing was shortened. */
  result: unknown;
  /** Full copies of every memory that was shortened, keyed by id. */
  shortened: Map<number, Rec>;
}

/**
 * Apply a character budget to a recall result ({ memories, team_memories }).
 * Walks the results in ranked order. The first memory is always complete; each
 * following one is complete while the running total stays inside the budget;
 * the rest become snippets marked `truncated: true` with their real length.
 */
export function applyRecallBudget(result: unknown, budget: number): BudgetOutcome {
  const shortened = new Map<number, Rec>();
  if (!(budget > 0) || !result || typeof result !== 'object' || Array.isArray(result)) {
    return { result, shortened };
  }
  const r = result as Rec;
  let used = 0;
  let seen = 0;
  const cutIds: number[] = [];

  const walk = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    return list.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const m = item as Rec;
      const content = m.content;
      if (typeof content !== 'string') return item;
      const first = seen === 0;
      seen++;
      const id = memoryId(m);
      // A memory without an id cannot be asked for again, so it is never cut.
      if (first || id === null || content.length <= SNIPPET_CHARS || used + content.length <= budget) {
        used += content.length;
        return item;
      }
      used += SNIPPET_CHARS;
      shortened.set(id, m);
      cutIds.push(id);
      return {
        ...m,
        content: content.slice(0, SNIPPET_CHARS).trimEnd() + ' [...]',
        truncated: true,
        full_chars: content.length,
      };
    });
  };

  const memories = walk(r.memories);
  const teamMemories = walk(r.team_memories);
  if (cutIds.length === 0) return { result, shortened };

  const out: Rec = { ...r };
  if ('memories' in r) out.memories = memories;
  if ('team_memories' in r) out.team_memories = teamMemories;
  out.truncated_note =
    `${cutIds.length} of ${seen} memories were shortened to fit max_chars=${budget}; the best-ranked ones are complete. ` +
    `To read a shortened memory in full, call recall_memories again with the same query and expand_ids: [${cutIds.join(', ')}]. ` +
    `Pass max_chars: 0 to get every result in full.`;
  return { result: out, shortened };
}

/**
 * Shorten the related-memory preview on a save response. The preview is only a
 * pointer ("something similar exists, here is its id"), so it does not need
 * the whole text. Callers skip this when the similarity is high enough that
 * the agent may merge the two, because merging needs the full text.
 */
export function trimRelatedPreview(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Rec;
  const related = r.potentially_related;
  if (!related || typeof related !== 'object' || Array.isArray(related)) return result;
  const rel = related as Rec;
  const content = rel.content;
  if (typeof content !== 'string' || content.length <= RELATED_PREVIEW_CHARS) return result;
  return {
    ...r,
    potentially_related: {
      ...rel,
      content: content.slice(0, RELATED_PREVIEW_CHARS).trimEnd() + ' [...]',
      content_truncated: true,
      content_chars: content.length,
    },
  };
}
