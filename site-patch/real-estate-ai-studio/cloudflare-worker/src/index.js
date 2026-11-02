const IMAGEN_BASE = "https://api.imagen-ai.com/v1";
const ALLOWED_ORIGINS = new Set(["https://18436002821.github.io"]);

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://18436002821.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Studio-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) }
  });
}

function cleanName(value) {
  return String(value || "房源照片")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 64) || "房源照片";
}

async function imagen(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("x-api-key", env.IMAGEN_API_KEY);
  const response = await fetch(IMAGEN_BASE + path, { ...init, headers });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw }; }
  if (!response.ok) {
    const message = body?.detail || body?.message || body?.error || "Imagen API 请求失败";
    throw new Error("Imagen API " + response.status + ": " + String(message).slice(0, 300));
  }
  return body;
}

function statusValue(payload) {
  return payload?.data?.status || payload?.status || payload?.data?.project?.status || "Unknown";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    let path = url.pathname; while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (!path.startsWith("/api/")) return json({ error: "Not found" }, 404, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "来源未授权" }, 403, origin);
    if (!env.STUDIO_ACCESS_TOKEN || request.headers.get("X-Studio-Token") !== env.STUDIO_ACCESS_TOKEN) {
      return json({ error: "工作台访问码不正确" }, 401, origin);
    }
    if (!env.IMAGEN_API_KEY) return json({ error: "服务端尚未配置 IMAGEN_API_KEY" }, 503, origin);

    try {
      if (path === "/api/health" && request.method === "GET") {
        await imagen(env, "/profiles/", { method: "GET" });
        return json({
          connected: true,
          engine: "Imagen AI",
          preset: "Natural Home",
          profile_key: 333757,
          note: "API 密钥已验证"
        }, 200, origin);
      }

      if (path === "/api/retouch" && request.method === "POST") {
        const form = await request.formData();
        const files = form.getAll("photos").filter(value => value && typeof value === "object" && typeof value.arrayBuffer === "function");
        if (!files.length) return json({ error: "没有收到照片" }, 400, origin);
        if (files.length > 12) return json({ error: "单次最多精修 12 张，请分批上传" }, 400, origin);
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > 70 * 1024 * 1024 || files.some(file => file.size > 18 * 1024 * 1024)) {
          return json({ error: "照片总大小不能超过 70MB，单张不能超过 18MB" }, 413, origin);
        }

        const names = files.map((file, index) => {
          const original = cleanName(file.name || ("photo_" + (index + 1) + ".jpg"));
          const dot = original.lastIndexOf(".");
          const base = dot > 0 ? original.slice(0, dot) : original;
          return String(index + 1).padStart(3, "0") + "_" + base + ".jpg";
        });
        const projectResponse = await imagen(env, "/projects/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: cleanName(form.get("projectName")) })
        });
        const projectUuid = projectResponse?.data?.project_uuid || projectResponse?.project_uuid;
        if (!projectUuid) throw new Error("Imagen 未返回项目编号");

        const linkResponse = await imagen(env, "/projects/" + encodeURIComponent(projectUuid) + "/get_temporary_upload_links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files_list: names.map(file_name => ({ file_name })) })
        });
        const uploadList = linkResponse?.data?.files_list || [];
        if (uploadList.length !== files.length) throw new Error("Imagen 返回的上传链接数量不匹配");

        for (let index = 0; index < files.length; index++) {
          const fileName = uploadList[index].file_name || names[index];
          const uploadLink = uploadList[index].upload_link;
          if (!uploadLink) throw new Error("缺少第 " + (index + 1) + " 张照片的上传链接");
          const uploadResponse = await fetch(uploadLink, {
            method: "PUT",
            headers: { "Content-Type": "" },
            body: files[index]
          });
          if (!uploadResponse.ok) throw new Error("第 " + (index + 1) + " 张照片上传失败（" + uploadResponse.status + "）");
          names[index] = fileName;
        }

        await imagen(env, "/projects/" + encodeURIComponent(projectUuid) + "/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile_key: 333757,
            photography_type: "REAL_ESTATE",
            hdr_merge: false,
            perspective_correction: true,
            sky_replacement: false,
            window_pull: true,
            export: true,
            crop: false,
            straighten: false,
            portrait_crop: false,
            headshot_crop: false,
            subject_mask: false,
            smooth_skin: false
          })
        });

        return json({
          project_uuid: projectUuid,
          files: names,
          count: files.length,
          preset: "Natural Home",
          status: "Pending"
        }, 202, origin);
      }

      const segments = path.split("/").filter(Boolean);
      if (match) {
        const projectUuid = decodeURIComponent(segments[2]);
        const action = segments[3];

        if (action === "status" && request.method === "GET") {
          const stage = url.searchParams.get("stage") === "export" ? "export" : "edit";
          const suffix = stage === "export" ? "/export/status" : "/edit/status";
          const payload = await imagen(env, "/projects/" + encodeURIComponent(projectUuid) + suffix, { method: "GET" });
          return json({ status: statusValue(payload), raw: payload }, 200, origin);
        }

        if (action === "download-links" && request.method === "GET") {
          const payload = await imagen(env, "/projects/" + encodeURIComponent(projectUuid) + "/export/get_temporary_download_links", { method: "GET" });
          const files = payload?.data?.files_list || [];
          return json({ files_list: files.map(file => ({ file_name: file.file_name })) }, 200, origin);
        }

        if (action === "download" && request.method === "GET") {
          const requestedName = url.searchParams.get("file");
          if (!requestedName) return json({ error: "缺少文件名" }, 400, origin);
          const payload = await imagen(env, "/projects/" + encodeURIComponent(projectUuid) + "/export/get_temporary_download_links", { method: "GET" });
          const files = payload?.data?.files_list || [];
          const file = files.find(item => item.file_name === requestedName);
          if (!file?.download_link) return json({ error: "没有找到精修照片下载链接" }, 404, origin);
          const upstream = await fetch(file.download_link);
          if (!upstream.ok) throw new Error("下载精修照片失败（" + upstream.status + "）");
          const safe = cleanName(requestedName).replace(/["\\r\\n]/g, "_");
          return new Response(upstream.body, {
            status: 200,
            headers: {
              ...cors(origin),
              "Content-Type": "image/jpeg",
              "Content-Disposition": (url.searchParams.get("inline") === "1" ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(safe),
              "Cache-Control": "private, no-store"
            }
          });
        }
      }

      return json({ error: "不支持的 API 路径" }, 404, origin);
    } catch (error) {
      return json({ error: String(error?.message || error).slice(0, 500) }, 500, origin);
    }
  }
};
