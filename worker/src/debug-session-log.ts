const DEBUG_SESSION_ID = "381494";
const DEBUG_INGEST =
  "http://127.0.0.1:7461/ingest/ee45bef0-757b-42ac-b41b-7b7017f150db";

export function debugSessionLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string
): void {
  const payload = {
    sessionId: DEBUG_SESSION_ID,
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  };
  // #region agent log
  console.log(`[debug-${DEBUG_SESSION_ID}]`, JSON.stringify(payload));
  // #endregion
}
