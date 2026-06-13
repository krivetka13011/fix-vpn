import type { BotEnv } from "./env";
import { resolveVpnHost } from "./env";

export const PANEL_ORIGIN_IP_DEFAULT = "31.76.2.248";

type CfRequestInit = RequestInit & {
  cf?: {
    resolveOverride?: string;
    [key: string]: unknown;
  };
};

export function panelOriginIp(env: BotEnv): string {
  return env.PANEL_ORIGIN_IP?.trim() || PANEL_ORIGIN_IP_DEFAULT;
}

/** Bypass Cloudflare orange-cloud (526) by resolving panel hostname to origin IP. */
export function panelOriginResolveInit(url: string, env: BotEnv): CfRequestInit {
  try {
    const { hostname } = new URL(url);
    const panelHost = resolveVpnHost(env);
    if (hostname === panelHost) {
      return { cf: { resolveOverride: panelOriginIp(env) } };
    }
  } catch {
    // ignore bad URL
  }
  return {};
}

export async function panelFetch(
  env: BotEnv,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const cfInit = panelOriginResolveInit(url, env);
  const merged: CfRequestInit = { ...init, ...cfInit };
  if (init && cfInit.cf) {
    merged.cf = { ...(init as CfRequestInit).cf, ...cfInit.cf };
  }
  return fetch(url, merged);
}

export function isPanelErrorBody(text: string, status: number): boolean {
  const trimmed = text.trim();
  return (
    status === 526 ||
    trimmed.includes("error code: 526") ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html")
  );
}
