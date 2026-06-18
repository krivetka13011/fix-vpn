import { handleApiRequest, type ApiEnv } from "./api-handler";
import {
  isShortSubscriptionPath,
  shortSubscriptionPathToSub,
} from "./connect-links";
import { subscriptionPublicHost, workerPaused } from "./env";
import { runSubscriptionExpiryJobs } from "./subscription-expiry";
import { runPendingPlategaReconcile } from "./platega-reconcile";

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
}

function pausedResponse(path: string): Response {
  if (path === "/api/health" || path === "/health") {
    return Response.json(
      { ok: false, paused: true, message: "FIX VPN temporarily paused" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  return new Response("FIX VPN temporarily paused", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "3600",
      "Cache-Control": "no-store",
    },
  });
}

function withAssetCors(request: Request, response: Response): Response {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
  }
  if (response.status === 404) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    let path = url.pathname;
    if (
      url.hostname === subscriptionPublicHost(env) &&
      isShortSubscriptionPath(path)
    ) {
      path = shortSubscriptionPathToSub(path);
    }

    if (workerPaused(env)) {
      return pausedResponse(path);
    }

    if (path === "/health" || path.startsWith("/api/") || path.startsWith("/sub/") || path.startsWith("/json/")) {
      return handleApiRequest(request, env, path, ctx);
    }

    return withAssetCors(request, await env.ASSETS.fetch(request));
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    if (workerPaused(env)) return;
    ctx.waitUntil(
      Promise.all([
        runSubscriptionExpiryJobs(env),
        runPendingPlategaReconcile(env),
      ]).catch((error) => {
        console.error("scheduled jobs:", error);
      })
    );
  },
};
