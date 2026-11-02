# 居信地产 AI 精修后端（Imagen AI）

这个 Worker 为 GitHub Pages 前端提供安全的服务端代理。Imagen API Key 只保存在 Cloudflare Worker Secret 中，不会进入网页代码。

## 使用的 AI 引擎

- Imagen AI Real Estate API
- 预设：Natural Home（JPEG profile_key: 333757）
- 默认工具：窗户曝光优化、室内透视校正
- 默认关闭：天空替换、HDR 合成（普通单张 JPG 不应误开 HDR）
- 只处理照片本身，不主动增加家具、装饰或更换空间风格

Imagen 按处理照片数量计费；官方文档说明新用户可先试用。实际免费额度和后续单张价格以账号内显示为准：
https://api-docs.imagen-ai.com/docs/guides/real-estate

## 部署

1. 在 Imagen 账号后台创建 API Key：https://account.imagen-ai.com/dashboard/
2. 安装 Node.js 后，在本目录执行：
   `npm install -g wrangler`
3. 登录 Cloudflare：
   `npx wrangler login`
4. 添加两个服务端密钥（不要把密钥写进网页或 GitHub）：
   `npx wrangler secret put IMAGEN_API_KEY`
   `npx wrangler secret put STUDIO_ACCESS_TOKEN`
   第二个访问码请自行设置为一段不易猜测的随机字符串。
5. 部署：
   `npx wrangler deploy`
6. 复制 Wrangler 输出的 Worker 地址，例如 `https://juxin-real-estate-ai.<你的账户>.workers.dev`
7. 打开居信地产 AI 精修工作台，在「AI 引擎连接」中填入 Worker 地址和刚才设置的工作台访问码，点击「测试连接」。

## API 路由

- `GET /api/health`：验证服务端 Imagen API Key
- `POST /api/retouch`：上传一组照片并启动 Natural Home 房产精修
- `GET /api/projects/:uuid/status?stage=edit|export`：查询处理状态
- `GET /api/projects/:uuid/download-links`：查询导出文件
- `GET /api/projects/:uuid/download?file=...`：通过 Worker 代理下载 JPEG

## 限制与说明

- 单批最多 12 张照片；单张最大 18MB；单批总量最大 70MB。
- 前端会将 PNG / WebP 转成 JPEG；原始上传文件不会被覆盖。
- 当前 Worker 只允许来自 `https://18436002821.github.io` 的浏览器跨域请求。
- 这是公司内部工作台，请不要把工作台访问码公开分享。
