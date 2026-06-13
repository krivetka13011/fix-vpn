export type E2eTraceEntry = {
  method: string;
  body: Record<string, unknown>;
};

type E2eSession = {
  dry: boolean;
  entries: E2eTraceEntry[];
};

const SESSION_KEY = "__fixVpnE2eSession";

function getSession(): E2eSession | null {
  return (globalThis as Record<string, E2eSession | null>)[SESSION_KEY] ?? null;
}

function setSession(session: E2eSession | null): void {
  (globalThis as Record<string, E2eSession | null>)[SESSION_KEY] = session;
}

function cloneTraceBody(body: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  } catch {
    return { chat_id: body.chat_id, text: String(body.text ?? "").slice(0, 500) };
  }
}

export function beginE2eTrace(dry: boolean): void {
  setSession({ dry, entries: [] });
}

export function endE2eTrace(): { dry: boolean; entries: E2eTraceEntry[] } | null {
  const current = getSession();
  setSession(null);
  if (!current) return null;
  return { dry: current.dry, entries: current.entries };
}

export function isE2eDryRun(): boolean {
  return Boolean(getSession()?.dry);
}

export function recordE2eTrace(
  method: string,
  body: Record<string, unknown>
): void {
  const session = getSession();
  if (!session) return;
  session.entries.push({ method, body: cloneTraceBody(body) });
}
