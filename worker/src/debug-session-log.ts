import type { BotEnv } from "./env";

const DEBUG_SESSION_ID = "381494";
const DEBUG_KV_KEY = `dbg:${DEBUG_SESSION_ID}`;
const DEBUG_INGEST =
  "http://127.0.0.1:7461/ingest/ee45bef0-757b-42ac-b41b-7b7017f150db";
const MAX_KV_ENTRIES = 40;

type DebugEntry = {
  sessionId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
  hypothesisId: string;
  timestamp: number;
};

function buildPayload(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): DebugEntry {
  return {
    sessionId: DEBUG_SESSION_ID,
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  };
}

export function debugSessionLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): void {
  const payload = buildPayload(location, message, data, hypothesisId);
  // #region agent log
  console.log(`[debug-${DEBUG_SESSION_ID}]`, JSON.stringify(payload));
  fetch(DEBUG_INGEST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
}

export async function debugSessionLogKv(
  env: BotEnv,
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): Promise<void> {
  const payload = buildPayload(location, message, data, hypothesisId);
  debugSessionLog(location, message, data, hypothesisId);
  if (!env.KV) return;
  try {
    const raw = await env.KV.get(DEBUG_KV_KEY);
    const entries: DebugEntry[] = raw ? JSON.parse(raw) : [];
    entries.push(payload);
    while (entries.length > MAX_KV_ENTRIES) entries.shift();
    await env.KV.put(DEBUG_KV_KEY, JSON.stringify(entries), {
      expirationTtl: 86_400,
    });
  } catch {
    // ignore KV debug failures
  }
}

export async function readDebugSessionLogs(env: BotEnv): Promise<DebugEntry[]> {
  if (!env.KV) return [];
  try {
    const raw = await env.KV.get(DEBUG_KV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
