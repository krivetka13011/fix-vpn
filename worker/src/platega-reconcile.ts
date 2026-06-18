import { approvePaidTransaction } from "./approve-transaction";
import { dbg381494 } from "./debug-session-log";
import type { BotEnv } from "./env";
import { getPlategaTransactionStatus, isPlategaConfigured } from "./platega";
import {
  getTransactionByPlategaId,
  getTransactionByPayloadId,
  listPendingPlategaTransactions,
  listPendingPlategaTransactionsForUser,
  patchTransaction,
} from "./repository";

export async function reconcilePlategaTransaction(
  env: BotEnv,
  txnId: string,
  plategaId: string
): Promise<{ ok: boolean; status: string }> {
  const status = await getPlategaTransactionStatus(env, plategaId);
  // #region agent log
  await dbg381494(env, "A", "platega-reconcile.ts", "poll_status", {
    txnSuffix: txnId.slice(-8),
    status,
  });
  // #endregion
  if (status === "CONFIRMED") {
    const result = await approvePaidTransaction(env, txnId);
    return { ok: result.ok, status };
  }
  if (status === "CANCELED") {
    await patchTransaction(env, txnId, { status: "rejected" });
  }
  return { ok: false, status };
}

export async function runPendingPlategaReconcile(env: BotEnv): Promise<void> {
  if (!isPlategaConfigured(env)) return;
  const rows = await listPendingPlategaTransactions(env, 30);
  for (const txn of rows) {
    const plategaId = txn.platega_transaction_id?.trim();
    if (!plategaId) continue;
    try {
      await reconcilePlategaTransaction(env, txn.id, plategaId);
    } catch (error) {
      console.error("platega reconcile:", txn.id, error);
    }
  }
}

export async function runUserPendingPlategaReconcile(
  env: BotEnv,
  userId: string
): Promise<void> {
  if (!isPlategaConfigured(env)) return;
  const rows = await listPendingPlategaTransactionsForUser(env, userId);
  for (const txn of rows) {
    const plategaId = txn.platega_transaction_id?.trim();
    if (!plategaId) continue;
    try {
      await reconcilePlategaTransaction(env, txn.id, plategaId);
    } catch (error) {
      console.error("platega user reconcile:", txn.id, error);
    }
  }
}

export async function reconcilePlategaFromReturnUrl(
  env: BotEnv,
  request: Request
): Promise<void> {
  if (!isPlategaConfigured(env)) return;
  const url = new URL(request.url);
  const plategaId =
    url.searchParams.get("transactionId")?.trim() ||
    url.searchParams.get("id")?.trim() ||
    "";
  const payloadId = url.searchParams.get("payload")?.trim() || "";

  let txn = plategaId ? await getTransactionByPlategaId(env, plategaId) : null;
  if (!txn && payloadId) txn = await getTransactionByPayloadId(env, payloadId);
  if (!txn || txn.status !== "pending") return;

  const id = txn.platega_transaction_id?.trim() || plategaId;
  if (!id) return;
  // #region agent log
  await dbg381494(env, "B", "platega-reconcile.ts", "return_url_reconcile", {
    txnSuffix: txn.id.slice(-8),
  });
  // #endregion
  await reconcilePlategaTransaction(env, txn.id, id);
}
