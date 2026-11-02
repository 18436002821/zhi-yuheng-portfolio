const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const ALLOWED_ORIGINS = new Set(["https://18436002821.github.io"]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function cors(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Studio-Token",
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

function decodeModelImage(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("AI 模型没有返回图片数据");
  }

  const clean = value.replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw new Error("AI 返回的图片编码无法识别");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageMime(bytes) {
  if (bytes.length >= 8 &&
      bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 &&
      bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
    return "image/webp";
  }
  return "image/png";
}

const RETOUCH_PROMPT = [
  "Professionally retouch this exact real-estate interior photograph for a property listing.",
  "The input photograph is the source of truth. Preserve the same property, exact room layout, architecture, dimensions, camera viewpoint, lens perspective, wall and ceiling lines, floor pattern, window and door positions, exterior view, lighting fixtures, furniture, appliances, decorations, and every object's position and scale.",
  "Do not add, remove, replace, move, resize, redesign, stage, or invent any object. Do not widen the room, alter the floor plan, change the windows, or fabricate details outside the windows.",
  "Only apply restrained professional photographic post-processing: correct color cast with natural neutral white balance, recover highlights, gently lift dark shadows, balance exposure, keep whites clean but not clipped, preserve realistic wood and fabric colors, retain fine surface texture, and apply very subtle clarity and noise reduction.",
  "Keep daylight and warm practical lights believable. Maintain the original composition and aspect ratio.",
  "The result must look like a faithful, natural, true-to-life photograph of the same room, not an interior redesign, CGI render, illustration, or dramatic HDR image."
].join(" ");

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "来源未授权。请从居信地产 AI 精修工作台访问。" }, 403, origin);
    }

    if (path !== "/api/health" && path !== "/api/retouch") {
      return json({ error: "不支持的 API 路径" }, 404, origin);
    }

    if (!env.STUDIO_ACCESS_TOKEN) {
      return json({ error: "后端尚未设置 STUDIO_ACCESS_TOKEN，请先完成 Cloudflare Worker 配置。" }, 503, origin);
    }

    if (request.headers.get("X-Studio-Token") !== env.STUDIO_ACCESS_TOKEN) {
      return json({ error: "工作台访问码不正确" }, 401, origin);
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return json({ error: "Workers AI 尚未绑定。请在 Worker 设置中添加名为 AI 的 Workers AI 绑定并重新部署。" }, 503, origin);
    }

    if (path === "/api/health" && request.method === "GET") {
      return json({
        connected: true,
        engine: "Cloudflare Workers AI",
        model: MODEL,
        mode: "image-to-image",
        note: "AI 图生图服务已连接"
      }, 200, origin);
    }

    if (path === "/api/retouch" && request.method === "POST") {
      try {
        const form = await request.formData();
        const photo = form.get("photo");
        if (!photo || typeof photo.arrayBuffer !== "function") {
          return json({ error: "没有收到有效照片" }, 400, origin);
        }
        if (!String(photo.type || "").startsWith("image/")) {
          return json({ error: "仅支持 JPG、PNG 或 WEBP 图片" }, 415, origin);
        }
        if (photo.size > MAX_IMAGE_BYTES) {
          return json({ error: "单张照片经预处理后仍超过 12MB，请换一张较小的图片" }, 413, origin);
        }

        const width = clamp(Math.round(Number(form.get("width")) || 1024), 256, 1920);
        const height = clamp(Math.round(Number(form.get("height")) || 1024), 256, 1920);
        const inputBytes = await photo.arrayBuffer();

        const modelForm = new FormData();
        modelForm.set("prompt", RETOUCH_PROMPT);
        modelForm.set("width", String(width));
        modelForm.set("height", String(height));
        modelForm.set(
          "input_image_0",
          new Blob([inputBytes], { type: photo.type || "image/jpeg" }),
          "property-photo.jpg"
        );

        // FLUX.2 Klein uses multipart input, including when editing one reference photo.
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

        return new Response(outputBytes, {
          status: 200,
          headers: {
            "Content-Type": mime,
            "Content-Length": String(outputBytes.byteLength),
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "X-AI-Model": "FLUX.2-Klein-4B",
            ...cors(origin)
          }
        });
      } catch (error) {
        return json({
          error: "AI 精修失败：" + String(error?.message || error).slice(0, 360)
        }, 502, origin);
      }
    }

    return json({ error: "请求方法不受支持" }, 405, origin);
  }
};
