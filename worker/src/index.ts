export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    return new Response(
      `<!DOCTYPE html><html><body style="background:#121212;color:#fff;font-family:sans-serif;padding:24px"><h1>FIX VPN</h1><p>???? ????????. API ????????????...</p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
