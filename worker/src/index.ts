import { handleApiRequest, type ApiEnv } from "./api-handler";

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/sub/") || url.pathname.startsWith("/json/")) {
      return handleApiRequest(request, env, url.pathname);
    }

    return withAssetCors(request, await env.ASSETS.fetch(request));
  },
};
