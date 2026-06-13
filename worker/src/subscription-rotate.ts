import type { BotEnv } from "./env";
import { patchSubscription } from "./repository";

/** Clear stuck rotation/IP flags after unbind — no subId rotation (testing without IP limits). */
export async function clearDeviceSwapState(
  env: BotEnv,
  userId: string
): Promise<void> {
  await patchSubscription(env, userId, {
    pending_xray_sub_id: null,
    panel_sub_rotate_requested_at: null,
    panel_ip_clear_requested_at: null,
  });
}
