export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export function normalizeSupabaseUrl(url: string): string {
  return url.trim().replace(/\/$/, "").replace(/\/rest\/v1\/?$/i, "");
}

export async function sbRequest(
  env: SupabaseEnv,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = normalizeSupabaseUrl(env.SUPABASE_URL);
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("Authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${base}/rest/v1/${path}`, { ...init, headers });
}

export async function sbJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Supabase ${res.status}`);
  }
  if (res.status === 204) return [] as T;
  return res.json() as Promise<T>;
}
