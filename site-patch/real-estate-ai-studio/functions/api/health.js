import { proxyToAiWorker } from "../_shared/worker-proxy.js";

export function onRequestGet({ request }) {
  return proxyToAiWorker(request, "/api/health");
}
