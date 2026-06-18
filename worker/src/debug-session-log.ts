import type { StorageEnv } from "./storage-env";

const SESSION = "381494";
const KV_KEY = `dbg:${SESSION}`;
const MAX_ENTRIES = 40;

type DebugEntry = {
  sessionId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
};

function sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|secret|password|authorization/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function dbg381494(
  env: StorageEnv,
  hypothesisId: string,
  location: string,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const entry: DebugEntry = {
    sessionId: SESSION,
    hypothesisId,
    location,
    message,
    data: sanitize(data),
    timestamp: Date.now(),
  };
  console.error(`[DBG381494] ${JSON.stringify(entry)}`);
  try {
    const kv = env.KV;
    if (!kv) return;
    const raw = (await kv.get(KV_KEY)) || "[]";
    const list = JSON.parse(raw) as DebugEntry[];
    list.push(entry);
    while (list.length > MAX_ENTRIES) list.shift();
    await kv.put(KV_KEY, JSON.stringify(list), { expirationTtl: 86400 });
  } catch (error) {
    console.error("dbg381494 kv:", error);
  }
}

export async function readDbg381494(env: StorageEnv): Promise<DebugEntry[]> {
  try {
    const raw = await env.KV?.get(KV_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DebugEntry[];
  } catch {
    return [];
  }
}
