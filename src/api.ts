/**
 * CogmemAi API client — thin HTTP wrapper with retry logic.
 */

import { API_BASE, API_KEY, VERSION, RETRY_CONFIG } from './config.js';

if (!API_KEY) {
  console.error(
    'Warning: COGMEMAI_API_KEY not set. Get your key at https://hifriendbot.com/developer/'
  );
}

/**
 * Fetch with exponential backoff retry for transient failures.
 */
async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      // Don't retry client errors (except retryable ones like 429)
      const retryable = RETRY_CONFIG.retryableStatusCodes as readonly number[];
      if (res.ok || !retryable.includes(res.status)) {
        return res;
      }

      // Retryable server error — retry if attempts remain
      if (attempt < RETRY_CONFIG.maxRetries) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt) + Math.random() * 200,
          RETRY_CONFIG.maxDelayMs
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res; // Final attempt — return whatever we got
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RETRY_CONFIG.maxRetries) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt) + Math.random() * 200,
          RETRY_CONFIG.maxDelayMs
        );
        await new Promise((r) => setTimeout(r, delay));
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
  body?: Record<string, unknown>
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
      const res = await fetchWithRetry(fullUrl, { method, headers });
      const data = await res.json();
      if (!res.ok) {
        const error =
          (data as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(error);
      }
      return data;
    }
  }

  const res = await fetchWithRetry(url, options);
  const data = await res.json();

  if (!res.ok) {
    const error = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(error);
  }

  return data;
}
