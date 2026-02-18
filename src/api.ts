/**
 * CogmemAi API client — thin HTTP wrapper for the HiFriendbot REST API.
 */

const API_BASE =
  process.env.COGMEMAI_API_URL?.replace(/\/+$/, '') ||
  'https://hifriendbot.com/wp-json/hifriendbot/v1';

const API_KEY = process.env.COGMEMAI_API_KEY || '';

if (!API_KEY) {
  console.error(
    'Warning: COGMEMAI_API_KEY not set. Get your key at https://hifriendbot.com/developer/'
  );
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
    'User-Agent': 'CogmemAi-MCP/1.0',
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
      const res = await fetch(fullUrl, { method, headers });
      const data = await res.json();
      if (!res.ok) {
        const error =
          (data as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(error);
      }
      return data;
    }
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    const error = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(error);
  }

  return data;
}
