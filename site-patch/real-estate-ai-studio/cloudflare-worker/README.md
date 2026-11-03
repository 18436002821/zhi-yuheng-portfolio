# 居信地产 AI 精修后端（Cloudflare Workers AI）

本后端把 GitHub Pages 工作台连接到真正的图生图模型 **FLUX.2 Klein 4B**。公开免验证模式下，同事打开网页即可使用，不需要输入 Worker 地址、访问码或登录。

## 公开使用与防滥用

- 工作台固定连接：`https://juxin-real-estate-ai.3490705865.workers.dev`
- 只接受来自 `https://18436002821.github.io` 的浏览器跨域请求。
- 公开模式不使用 `STUDIO_ACCESS_TOKEN`；已有 Secret 可以保留，但新代码不会读取它。
- 每个来源 IP 每分钟最多 12 次精修请求。Cloudflare Rate Limiting 是近似限流，并非全球严格计数。
- 使用 SQLite Durable Object 维护全公司共享的每日工作台估算用量。
- 本工作台每日预算上限设为 7,000 估算 Neurons，预留部分 Cloudflare 免费额度给账户内其他 Workers AI 调用。
- 达到工作台预算后，服务会暂停当天的精修请求，次日北京时间 08:00（UTC 00:00）重置。
- 照片不会写入 Durable Object；持久化的只有每日估算 Neurons、提交张数和成功张数。

**重要：** Cloudflare Workers AI 免费额度是账户级每日 10,000 Neurons，其他 Worker 或其他项目的 AI 调用也会共同消耗。工作台的 7,000 Neurons 是本项目自己的估算上限，不是 Cloudflare 账户真实账单余额。网页显示的“预计还能精修”按 1920×1280 标准照片估算，实际张数会随照片尺寸、模型计费变化而变化。

## 模型与估算方式

- 模型：`@cf/black-forest-labs/flux-2-klein-4b`
- 按输入和输出 512×512 图像块价格估算：输入 5.37 Neurons / tile，输出 26.05 Neurons / tile。
- 工作台在估算值上额外增加 10% 缓冲。
- 每张照片在浏览器中先转换为 JPEG，最长边不超过 1920px，再提交给 Worker。
- 任何生成式模型都不能保证像素级保持现场细节。对外发布前请核对窗景、家具、设备、空间尺寸和房屋真实状况。

官方文档：
- 模型与价格：https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/
- Workers AI 定价：https://developers.cloudflare.com/workers-ai/platform/pricing/
- Rate Limiting：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Durable Objects：https://developers.cloudflare.com/durable-objects/

## 首次部署 / 更新 Worker

在电脑安装 Node.js 后，打开终端进入本目录：

```bash
npm install -g wrangler
npx wrangler login
npx wrangler deploy
```

部署时 Wrangler 会根据 `wrangler.toml`：
1. 保留现有 Workers AI 绑定 `AI`；
2. 创建并绑定 SQLite Durable Object `USAGE_COUNTER`；
3. 创建每 IP 每分钟 12 次的 `RETOUCH_RATE_LIMITER`；
4. 部署公开免验证版 Worker。

如果你之前设置过 `STUDIO_ACCESS_TOKEN`，不需要删除；新版 Worker 不再检查该 Secret。

## GitHub Pages 工作台

工作台地址：
https://18436002821.github.io/zhi-yuheng-portfolio/real-estate-ai-studio/

前端代码已经固定 Worker 地址，GitHub Pages 更新后无需同事逐台输入连接信息。**GitHub Pages 的自动发布不会自动部署 Cloudflare Worker**；Worker 源码更新后，仍需按上面的命令部署一次。

## API

- `GET /api/health`：检查 Workers AI、共享额度统计和限流绑定。
- `GET /api/usage`：读取全公司共享的每日估算用量。
- `POST /api/retouch`：接收一张预处理后的 JPG，执行 FLUX.2 Klein 4B 图生图精修并返回图片二进制。

## 数据与隐私

- Worker 不把上传照片写入 R2、KV 或数据库；处理结果直接返回浏览器。
- Durable Object 只保存每日汇总计数，不保存照片、文件名或用户身份信息。
- 照片会发送至 Cloudflare Workers AI 进行推理。请在对外发布前人工核对精修结果。
