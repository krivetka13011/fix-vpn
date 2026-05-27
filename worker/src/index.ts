import { handleApiRequest, type ApiEnv } from "./api-handler";

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApiRequest(request, env, url.pathname);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Worker error:", message);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
