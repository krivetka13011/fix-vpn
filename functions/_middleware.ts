import { handleApiRequest, type ApiEnv } from "../worker/src/api-handler";

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    return context.next();
  }

  try {
    return await handleApiRequest(
      context.request,
      context.env,
      url.pathname
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
