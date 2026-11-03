import { DurableObject } from "cloudflare:workers";

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const ALLOWED_ORIGINS = new Set(["https://18436002821.github.io"]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DAILY_NEURON_BUDGET = 7000;
const INPUT_NEURONS_PER_TILE = 5.37;
const OUTPUT_NEURONS_PER_TILE = 26.05;
const ESTIMATE_BUFFER = 1.1;

function cors(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors(origin)
    }
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimateNeurons(width, height) {
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
  return Math.ceil(tiles * (INPUT_NEURONS_PER_TILE + OUTPUT_NEURONS_PER_TILE) * ESTIMATE_BUFFER);
}

function nextUtcReset() {
  const date = new Date();
  date.setUTCHours(24, 0, 0, 0);
  return date.toISOString();
}

function emptyUsage(date) {
  return { date, estimatedUsedNeurons: 0, attemptedPhotos: 0, successfulPhotos: 0 };
}

function usageSnapshot(record) {
  const used = Math.max(0, Number(record.estimatedUsedNeurons) || 0);
  const remaining = Math.max(0, DAILY_NEURON_BUDGET - used);
  const standardPhotoNeurons = estimateNeurons(1920, 1280);
  return {
    date: record.date,
    dailyLimitNeurons: DAILY_NEURON_BUDGET,
    estimatedUsedNeurons: used,
    remainingNeurons: remaining,
    attemptedPhotos: Number(record.attemptedPhotos) || 0,
    successfulPhotos: Number(record.successfulPhotos) || 0,
    standardPhotoNeurons,
    estimatedRemainingPhotos: Math.floor(remaining / standardPhotoNeurons),
    resetsAt: nextUtcReset(),
    estimateOnly: true
  };
}

function getUsageStub(env) {
  if (!env.USAGE_COUNTER) throw new Error("缺少 USAGE_COUNTER Durable Object 绑定");
  const id = env.USAGE_COUNTER.idFromName("juxin-global-usage");
  return env.USAGE_COUNTER.get(id);
}

function decodeModelImage(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value !== "string" || !value.trim()) throw new Error("AI 模型没有返回图片数据");
  const clean = value.replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");
  let binary;
  try { binary = atob(clean); }
  catch { throw new Error("AI 返回的图片编码无法识别"); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
  return "image/png";
}

function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error("上传照片不是有效的 JPEG 图片");
  let offset = 2;
  const sofMarkers = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 255) { offset++; continue; }
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) break;
    if (marker === 0 || marker === 1 || (marker >= 208 && marker <= 215)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (!length || offset + length > bytes.length) break;
    if (sofMarkers.has(marker)) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  throw new Error("无法读取照片尺寸，请重新选择 JPG 图片");
}

const RETOUCH_PROMPT = [
  "Professionally retouch this exact real-estate interior photograph for a property listing.",
  "The input photograph is the source of truth. Preserve the same property, exact room layout, architecture, dimensions, camera viewpoint, lens perspective, wall and ceiling lines, floor pattern, window and door positions, exterior view, lighting fixtures, furniture, appliances, decorations, and every object's position and scale.",
  "Do not add, remove, replace, move, resize, redesign, stage, or invent any object. Do not widen the room, alter the floor plan, change the windows, or fabricate details outside the windows.",
  "Only apply restrained professional photographic post-processing: correct color cast with natural neutral white balance, recover highlights, gently lift dark shadows, balance exposure, keep whites clean but not clipped, preserve realistic wood and fabric colors, retain fine surface texture, and apply very subtle clarity and noise reduction.",
  "Keep daylight and warm practical lights believable. Maintain the original composition and aspect ratio.",
  "The result must look like a faithful, natural, true-to-life photograph of the same room, not an interior redesign, CGI render, illustration, or dramatic HDR image."
].join(" ");

export class UsageCounter extends DurableObject {
  constructor(ctx, env) { super(ctx, env); }

  async fetch(request) {
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);

    if (url.pathname === "/status" && request.method === "GET") {
      const stored = await this.ctx.storage.get("daily_usage");
      const record = stored && stored.date === today ? stored : emptyUsage(today);
      return json(usageSnapshot(record));
    }

    if (url.pathname === "/consume" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const neurons = clamp(Math.ceil(Number(body.neurons) || 0), 1, 5000);
      const result = await this.ctx.storage.transaction(async txn => {
        const stored = await txn.get("daily_usage");
        const record = stored && stored.date === today ? stored : emptyUsage(today);
        if (record.estimatedUsedNeurons + neurons > DAILY_NEURON_BUDGET) return { allowed: false, record };
        record.estimatedUsedNeurons += neurons;
        record.attemptedPhotos += 1;
        await txn.put("daily_usage", record);
        return { allowed: true, record };
      });
      return json({ allowed: result.allowed, ...usageSnapshot(result.record) });
    }

    if (url.pathname === "/success" && request.method === "POST") {
      const record = await this.ctx.storage.transaction(async txn => {
        const stored = await txn.get("daily_usage");
        const current = stored && stored.date === today ? stored : emptyUsage(today);
        current.successfulPhotos += 1;
        await txn.put("daily_usage", current);
        return current;
      });
      return json(usageSnapshot(record));
    }

    return json({ error: "不支持的额度统计路径" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "来源未授权。请从居信地产 AI 精修工作台访问。" }, 403, origin);

    if (path !== "/api/health" && path !== "/api/usage" && path !== "/api/retouch") {
      return json({ error: "不支持的 API 路径" }, 404, origin);
    }

    if (path === "/api/health" && request.method === "GET") {
      if (!env.AI || typeof env.AI.run !== "function") return json({ connected: false, error: "Workers AI 尚未绑定" }, 503, origin);
      if (!env.USAGE_COUNTER || !env.RETOUCH_RATE_LIMITER) {
        return json({ connected: false, error: "公开工作台防滥用绑定尚未配置，请完成 USAGE_COUNTER 与 RETOUCH_RATE_LIMITER 绑定并部署" }, 503, origin);
      }
      return json({
        connected: true,
        publicAccess: true,
        engine: "Cloudflare Workers AI",
        model: MODEL,
        mode: "image-to-image",
        dailyStudioBudgetNeurons: DAILY_NEURON_BUDGET,
        note: "公开免验证模式已启用；额度面板显示本工作台的估算消耗"
      }, 200, origin);
    }

    if (path === "/api/usage" && request.method === "GET") {
      try {
        const stub = getUsageStub(env);
        const response = await stub.fetch("https://usage/status");
        const payload = await response.json();
        return json(payload, response.status, origin);
      } catch (error) {
        return json({ error: "共享额度统计暂不可用：" + String(error?.message || error).slice(0, 180) }, 503, origin);
      }
    }

    if (path === "/api/retouch" && request.method === "POST") {
      if (!env.AI || typeof env.AI.run !== "function") return json({ error: "Workers AI 尚未绑定，请在 Worker 设置中添加 AI 绑定" }, 503, origin);
      if (!env.USAGE_COUNTER || !env.RETOUCH_RATE_LIMITER) {
        return json({ error: "公开工作台防滥用绑定尚未配置，请完成绑定后重新部署" }, 503, origin);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await env.RETOUCH_RATE_LIMITER.limit({ key: ip });
      if (!rate.success) return json({ error: "当前网络请求较频繁，请稍等一分钟后再试。" }, 429, origin);

      const contentLength = Number(request.headers.get("Content-Length") || 0);
      if (contentLength && contentLength > MAX_IMAGE_BYTES + 512 * 1024) return json({ error: "上传内容过大，请重新选择照片" }, 413, origin);

      try {
        const form = await request.formData();
        const photo = form.get("photo");
        if (!photo || typeof photo.arrayBuffer !== "function") return json({ error: "没有收到有效照片" }, 400, origin);
        if (photo.type !== "image/jpeg") return json({ error: "请上传经过工作台预处理的 JPG 图片" }, 415, origin);
        if (photo.size > MAX_IMAGE_BYTES) return json({ error: "照片经预处理后仍超过 12MB，请换一张较小的图片" }, 413, origin);

        const inputBytes = await photo.arrayBuffer();
        const dimensions = readJpegDimensions(new Uint8Array(inputBytes));
        const width = dimensions.width;
        const height = dimensions.height;
        if (width > 1920 || height > 1920) return json({ error: "照片尺寸超出工作台预处理上限，请重新上传" }, 413, origin);

        const estimatedNeurons = estimateNeurons(width, height);
        const usageStub = getUsageStub(env);
        const consumeResponse = await usageStub.fetch("https://usage/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ neurons: estimatedNeurons })
        });
        const usage = await consumeResponse.json();
        if (!usage.allowed) {
          return json({ error: "本工作台今日的预估 AI 额度已用完，请在北京时间 08:00 后再试。", usage }, 429, origin);
        }

        const modelForm = new FormData();
        modelForm.set("prompt", RETOUCH_PROMPT);
        modelForm.set("width", String(width));
        modelForm.set("height", String(height));
        modelForm.set("input_image_0", new Blob([inputBytes], { type: "image/jpeg" }), "property-photo.jpg");

        const multipartRequest = new Response(modelForm);
        const modelResult = await env.AI.run(MODEL, {
          multipart: {
            body: multipartRequest.body,
            contentType: multipartRequest.headers.get("content-type")
          }
        });

        if (modelResult?.success === false || modelResult?.errors?.length) {
          const detail = modelResult.errors?.[0]?.message || "模型推理失败";
          throw new Error(detail);
        }

        const encodedImage = modelResult?.image || modelResult?.result?.image;
        const outputBytes = decodeModelImage(encodedImage);
        const mime = imageMime(outputBytes);
        try { await usageStub.fetch("https://usage/success", { method: "POST" }); }
        catch (usageError) { console.warn("Unable to update successful photo count:", usageError); }

        return new Response(outputBytes, {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Content-Length": String(outputBytes.byteLength),
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "X-AI-Model": "FLUX.2-Klein-4B",
            "X-AI-Estimated-Neurons": String(estimatedNeurons),
            ...cors(origin)
          }
        });
      } catch (error) {
        return json({ error: "AI 精修失败：" + String(error?.message || error).slice(0, 360) }, 502, origin);
      }
    }

    return json({ error: "请求方法不受支持" }, 405, origin);
  }
};
