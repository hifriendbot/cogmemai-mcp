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
 * Make an authenticated API request to the CogmemAi backend.
 */
export async function api(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
  timeoutMs?: number
): Promise<unknown> {
  const url = `${API_BASE}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `CogmemAi-MCP/${VERSION}`,
  };

  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
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
      const data = await res.json();
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
  const data = await res.json();

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
