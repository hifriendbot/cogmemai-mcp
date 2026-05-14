# Scope: cogmemai-mcp v3.20.0 — fail loud on HTML responses

**Why this matters:** today (2026-05-14) we discovered NinjaFirewall on hifriendbot.com had been silently blocking ~30% of CogmemAi memory writes for ~5 weeks because `.htninja.bak` (the URL whitelist) was accidentally renamed and never restored. The `cogmemai-mcp` client received HTML 403 pages, threw "Unexpected token '<'" on JSON.parse, then silently retried the same blocked payload every 15 minutes for hours. No user-facing error ever surfaced. We lost weeks of autonomous memory.

This patch makes that failure mode loud.

## Files to modify

| File | Lines | What |
|---|---|---|
| `src/api.ts` | 112, 126 | Detect HTML responses before `.json()`. Throw a structured firewall-block error. |
| `src/api.ts` | 30-69 (`fetchWithRetry`) | Don't retry HTML 4xx responses. They aren't transient. |
| `src/config.ts` | 8 | Bump `VERSION` from `3.19.1` → `3.20.0`. |
| `package.json` | (root) | Bump version to match. |
| `README.md` | changelog section | Note v3.20.0 change. |

Total: ~25 lines of new code, ~5 lines changed.

## The patch shape

In `src/api.ts`, wrap the existing `await res.json()` calls:

```ts
async function safeParseJson(res: Response, url: string): Promise<unknown> {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  
  // HTML response = something between client and origin (firewall, CDN, web server)
  // is intercepting. Don't try to JSON.parse — surface a useful error.
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || ct.includes('text/html')) {
    const status = res.status;
    let detail = 'an upstream proxy or firewall';
    
    // Detect known sources by content sniff
    if (text.includes('NinjaFirewall')) detail = 'NinjaFirewall (WAF)';
    else if (text.includes('Cloudflare')) detail = 'Cloudflare';
    else if (text.includes('ModSecurity')) detail = 'ModSecurity';
    
    throw new Error(
      `CogmemAi backend returned HTML (HTTP ${status}) instead of JSON. ` +
      `Blocked by ${detail}. URL: ${url}. ` +
      `If this persists, the request payload may contain content the WAF flags as XSS. ` +
      `Contact support@hifriendbot.com or open an issue at github.com/hifriendbot/cogmemai-mcp.`
    );
  }
  
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`CogmemAi backend returned non-JSON response: ${text.slice(0, 200)}`);
  }
}
```

Then replace the two `await res.json()` calls in `api()` with `await safeParseJson(res, url)`.

In `fetchWithRetry`, add an early-out: if the response is `4xx` AND the body starts with HTML markers, do NOT retry. The block is deterministic, not transient.

```ts
// inside fetchWithRetry, after the fetch succeeds:
if (!res.ok && retryable.includes(res.status)) {
  // Peek at first 32 bytes; if it's HTML, the upstream proxy is blocking us. Don't retry.
  const peek = await res.clone().text();
  if (peek.startsWith('<!DOCTYPE') || peek.startsWith('<html')) {
    return res; // surface the HTML error immediately, no retry
  }
  // ... existing retry logic
}
```

## Test cases

Add to whatever test harness exists (or create one if not). Per session's CLAUDE.md, run `gitnexus_impact({target: "api", direction: "upstream"})` first to know what calls `api()` and which tests need to pass.

1. **Mock a 403 HTML response** — assert `safeParseJson` throws with "NinjaFirewall (WAF)" in the message
2. **Mock a 200 JSON response** — assert it parses normally
3. **Mock a 5xx HTML response** (Apache error) — assert it throws with "an upstream proxy or firewall"
4. **Mock a 503 with `Server: cloudflare` HTML body** — assert the message names Cloudflare
5. **Mock a 502 + retryable + HTML body** — assert `fetchWithRetry` does NOT retry (the existing logic would have)
6. **Mock a 502 + retryable + JSON body** — assert `fetchWithRetry` DOES retry (existing behavior preserved)

## Acceptance criteria

- [ ] All existing tests pass
- [ ] New tests added and pass
- [ ] `gitnexus_impact` shows zero HIGH/CRITICAL surprises
- [ ] `gitnexus_detect_changes` confirms only `src/api.ts`, `src/config.ts`, `package.json`, `README.md` changed
- [ ] Manual smoke test: temporarily rename `.htninja` to `.bak` on hifriendbot.com, run `recall_memories` from a fresh MCP session, confirm the error message is helpful (not "Unexpected token '<'")
- [ ] Restore `.htninja` after the smoke test
- [ ] Build clean: `npm run build`
- [ ] Publish: `npm publish` to push v3.20.0 to npm
- [ ] Commit + push to github.com/hifriendbot/cogmemai-mcp
- [ ] Save a memory noting v3.20.0 shipped, what changed, and that the silent-failure-on-HTML class of bug is now closed

## GitNexus discipline (per repo CLAUDE.md)

This repo enforces GitNexus impact analysis before symbol edits. Required commands BEFORE the edits:

```
gitnexus_impact({target: "api", direction: "upstream"})
gitnexus_impact({target: "fetchWithRetry", direction: "upstream"})
gitnexus_context({name: "api"})
```

After edits:

```
gitnexus_detect_changes({scope: "all"})
```

If `gitnexus` reports the index is stale, run `npx gitnexus analyze` first.

## Why this is worth a fresh session

The patch itself is small (~30 lines) but the GitNexus impact analysis on `api()` will surface every caller across `tools.ts`, `storage-cloud.ts`, `cli.ts`, `http-server.ts`, etc. Reviewing that impact tree, picking the right error-message wording (this gets shown to users), and adding the test cases together is genuinely an hour of focused work. Better in a fresh context than tacked onto a long session.

## Version + release log entry

Add to `README.md`:

```
## v3.20.0 (2026-05-XX)

- Detect HTML responses (firewall blocks, CDN error pages, server errors) and surface a clear error
  instead of throwing "Unexpected token '<'" on JSON.parse. Names the blocking layer when detectable
  (NinjaFirewall, Cloudflare, ModSecurity). Stops silent retry loops on deterministic 4xx blocks.
- Prevents the class of bug we hit 2026-05-14: 5 weeks of silently dropped autonomous memory
  because a WAF-block HTML 403 looked indistinguishable from a transient backend hiccup.
```
