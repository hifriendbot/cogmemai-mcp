/**
 * CogmemAi API client — thin HTTP wrapper with retry logic and timeouts.
 */

import { API_BASE, API_KEY, VERSION, RETRY_CONFIG, FETCH_TIMEOUT_MS, STORAGE_MODE } from './config.js';

if (!API_KEY && STORAGE_MODE !== 'local') {
  console.error(
    'Warning: COGMEMAI_API_KEY not set. Get your key at https://hifriendbot.com/developer/'
  );
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function retryDelay(attempt: number): number {
  return Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt) + Math.random() * 200,
    RETRY_CONFIG.maxDelayMs
  );
}

/**
 * Fetch with exponential backoff retry and request timeout.
 */
async function fetchWithRetry(url: string, options: RequestInit, timeoutMs?: number): Promise<Response> {
  const retryable = RETRY_CONFIG.retryableStatusCodes as readonly number[];
  const timeout = timeoutMs || FETCH_TIMEOUT_MS;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    // AbortController for per-request timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      // Don't retry client errors (except retryable ones like 429)
      if (res.ok || !retryable.includes(res.status)) {
        return res;
      }

      // Retryable status, but if the body looks like an HTML error page
      // (firewall/CDN/web-server intercept), the block is deterministic, not
      // transient. Retrying won't help — surface the response immediately.
      if (await responseLooksLikeHtml(res)) {
        return res;
      }

      // Retryable server error — retry if attempts remain
      if (attempt < RETRY_CONFIG.maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }

      return res; // Final attempt — return whatever we got
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));

      // Make timeout errors more descriptive
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeout}ms`);
      }

      if (attempt < RETRY_CONFIG.maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        continue;
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

/**
 * Peek at a response body without consuming it. Used to spot HTML
 * error pages (firewall/CDN/server intercepts) before retrying or
 * attempting JSON.parse.
 */
async function responseLooksLikeHtml(res: Response): Promise<boolean> {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) return true;
  try {
    const peek = (await res.clone().text()).trimStart().slice(0, 32).toLowerCase();
    return peek.startsWith('<!doctype') || peek.startsWith('<html');
  } catch {
    return false;
  }
}

/**
 * Read a response body as JSON, but if it's HTML (a firewall block, CDN
 * error page, or upstream-proxy intercept), throw a structured error that
 * names the blocking layer when possible. Replaces a bare `await res.json()`
 * which would otherwise throw an opaque "Unexpected token '<'..." parse error.
 *
 * Background: we lost ~5 weeks of CogmemAi memory in early 2026 because
 * NinjaFirewall returned HTML 403s that the client tried to JSON.parse,
 * threw a confusing parse error, and silently retried forever. This helper
 * is the cure — see SCOPE-v3.20.0.md for the full incident write-up.
 */
async function safeParseJson(res: Response, url: string): Promise<unknown> {
  const text = await res.text();
  const looksHtml =
    (res.headers.get('content-type') || '').includes('text/html') ||
    text.trimStart().slice(0, 32).toLowerCase().startsWith('<!doctype') ||
    text.trimStart().slice(0, 32).toLowerCase().startsWith('<html');

  if (looksHtml) {
    let blocker = 'an upstream proxy, CDN, or firewall';
    if (text.includes('NinjaFirewall')) blocker = 'NinjaFirewall (WAF)';
    else if (text.includes('Cloudflare')) blocker = 'Cloudflare';
    else if (text.includes('ModSecurity') || text.includes('Mod_Security')) blocker = 'ModSecurity';
    else if (text.includes('cPanel') || text.includes('LiteSpeed')) blocker = 'the web server';

    throw new Error(
      `CogmemAi backend returned HTML (HTTP ${res.status}) instead of JSON. ` +
      `Blocked by ${blocker}. URL: ${url}. ` +
      `If this persists, the request payload may contain content the WAF flags as XSS or code injection. ` +
      `For hifriendbot.com: verify /home/ganjacom/hifriendbot.com/.htninja exists and is not renamed to .bak. ` +
      `Otherwise report the URL + this message to support@hifriendbot.com or open an issue at github.com/hifriendbot/cogmemai-mcp.`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `CogmemAi backend returned non-JSON response (HTTP ${res.status}) from ${url}. ` +
      `First 200 chars: ${text.slice(0, 200)}`
    );
  }
}

/**
 * Make an authenticated API request to the CogmemAi backend.
 */
export async function api(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
  timeoutMs?: number,
  apiKeyOverride?: string
): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const key = apiKeyOverride || API_KEY;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `CogmemAi-MCP/${VERSION}`,
  };

  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }

  const options: RequestInit = { method, headers };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  // For GET with query params, append to URL
  if (body && method === 'GET') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) {
      const separator = url.includes('?') ? '&' : '?';
      const fullUrl = `${url}${separator}${qs}`;
      const res = await fetchWithRetry(fullUrl, { method, headers }, timeoutMs);
      const data = await safeParseJson(res, fullUrl);
      if (!res.ok) {
        if (res.status === 402) {
          throw new Error(format402Error(data));
        }
        const error =
          (data as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(error);
      }
      return data;
    }
  }

  const res = await fetchWithRetry(url, options, timeoutMs);
  const data = await safeParseJson(res, url);

  if (!res.ok) {
    // Surface x402 payment instructions clearly for 402 responses
    if (res.status === 402) {
      throw new Error(format402Error(data));
    }
    const error = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(error);
  }

  return data;
}

/**
 * Format a 402 Payment Required response into a clear, actionable message.
 */
function format402Error(data: unknown): string {
  const d = data as {
    error?: string;
    verification_error?: string;
    accepts?: Array<{
      payTo?: string;
      maxAmountRequired?: string;
      network?: string;
      description?: string;
      extra?: { name?: string; token?: string };
    }>;
  };

  const parts: string[] = ['Payment Required — free tier limit reached.'];

  if (d.verification_error) {
    parts.push(`Verification error: ${d.verification_error}`);
  }

  if (d.accepts && d.accepts.length > 0) {
    parts.push('Pay with USDC on-chain to continue:');
    // Show unique payment options (deduplicate v1/v2 formats by payTo+network)
    const seen = new Set<string>();
    for (const opt of d.accepts) {
      const key = `${opt.payTo}-${opt.network}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const amount = opt.maxAmountRequired && opt.extra?.name
        ? `${Number(opt.maxAmountRequired) / 1e6} ${opt.extra.name}`
        : opt.description || 'see details';
      parts.push(`  • ${amount} on ${opt.network} → ${opt.payTo}`);
    }
    parts.push('Use AgentWallet pay_x402 tool or send USDC directly, then retry with X-PAYMENT header.');
  }

  parts.push('Or subscribe at https://hifriendbot.com/developer/ for unlimited access.');

  return parts.join('\n');
}
