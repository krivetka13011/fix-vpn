export type E2eTraceEntry = {
  method: string;
  body: Record<string, unknown>;
};

type E2eSession = {
  dry: boolean;
  entries: E2eTraceEntry[];
};

let session: E2eSession | null = null;

export function beginE2eTrace(dry: boolean): void {
  session = { dry, entries: [] };
}

export function endE2eTrace(): { dry: boolean; entries: E2eTraceEntry[] } | null {
  const current = session;
  session = null;
  if (!current) return null;
  return { dry: current.dry, entries: current.entries };
}

export function isE2eDryRun(): boolean {
  return Boolean(session?.dry);
}

export function recordE2eTrace(
  method: string,
  body: Record<string, unknown>
): void {
  if (!session) return;
  session.entries.push({ method, body });
}
