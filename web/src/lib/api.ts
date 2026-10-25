const TOKEN_KEY = 'exotic.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Full parsed error body — lets callers read flags like needsTwoFactor. */
    public payload?: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  raw?: boolean; // return Response as-is (CSV/blob)
}

/** REST client: JWT bearer, JSON, normalized errors, global 401 handling. */
export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const { method = 'GET', body, raw } = opts;
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && getToken()) {
    clearToken();
    window.dispatchEvent(new CustomEvent('auth:expired'));
  }

  // Static hosting without the backend: unknown /api GETs fall back to the
  // SPA shell (200 text/html) and /api POSTs are rejected by the asset server
  // (405). The real API always answers JSON/CSV and never sends 405 — fail
  // with one honest message instead of parsing HTML as data.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html') || res.status === 405) {
    throw new ApiError(
      'The API is not connected on this deployment — start the backend server to sign in and load live data.',
      res.status,
      null,
    );
  }

  if (raw) {
    if (!res.ok) throw new ApiError(await res.text(), res.status);
    return res as unknown as T;
  }

  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data as T;
}

/** Open a file download with auth header (CSV/JSON exports). */
export async function downloadAuthed(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
