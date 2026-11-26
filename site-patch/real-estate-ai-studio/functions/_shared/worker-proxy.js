const WORKER_BASE_URL = "https://juxin-real-estate-ai.3490705865.workers.dev";
const FRONTEND_ORIGIN = "https://zhi-yuheng-portfolio.pages.dev";

export async function proxyToAiWorker(request, apiPath) {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(apiPath + incomingUrl.search, WORKER_BASE_URL);
  const headers = new Headers(request.headers);

  // The browser calls this Pages Function on the same origin.
  // Forward a known production origin to the existing Worker origin allowlist.
  headers.set("Origin", FRONTEND_ORIGIN);
  headers.delete("host");

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const upstream = await fetch(targetUrl.toString(), init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-AI-Proxy", "Cloudflare-Pages-Functions");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: "AI 后端暂时无法连接，请稍后重试。",
      detail: String(error?.message || error).slice(0, 160)
    }), {
      status: 502,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}
