import { proxyToAiWorker } from "../_shared/worker-proxy.js";

export function onRequestPost({ request }) {
  return proxyToAiWorker(request, "/api/retouch");
}
