# 居信地产 AI 精修后端（Cloudflare Workers AI）

本后端把 GitHub Pages 工作台连接到真正的图生图模型 **FLUX.2 Klein 4B**。它不是前端曝光/色温滤镜，而是把房源照片作为参考图交给 AI 模型重新处理，再把生成结果返回给浏览器。

## 免费额度

- 使用 Cloudflare Workers AI 的免费额度：每天 10,000 Neurons。
- 在 **Workers Free** 方案下，达到免费额度后请求会失败并等待额度重置，不会自动按超额用量收费。
- 不要把 Worker 升级到 Workers Paid；付费方案超出免费额度后会按 Neurons 计费。
- 免费额度、模型单价和可用性可能调整，请以 Cloudflare 账户中的最新显示为准。
- FLUX.2 Klein 4B 当前按输入/输出图像分块计费：输入每个 512×512 tile 为 5.37 Neurons，输出每个 512×512 tile 为 26.05 Neurons。

官方说明：
- 模型：https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/
- 免费额度与价格：https://developers.cloudflare.com/workers-ai/platform/pricing/
- 数据使用说明：https://developers.cloudflare.com/workers-ai/platform/data-usage/

## 部署前准备

1. 注册或登录 Cloudflare 免费账号：https://dash.cloudflare.com/
2. 电脑安装 Node.js：https://nodejs.org/
3. 打开终端，进入本目录：
   `cd site-patch/real-estate-ai-studio/cloudflare-worker`
4. 安装 Wrangler：
   `npm install -g wrangler`
5. 登录 Cloudflare：
   `npx wrangler login`
6. 设置工作台访问码（自己生成一段较长、难猜的随机字符串；不要把它写入 GitHub）：
   `npx wrangler secret put STUDIO_ACCESS_TOKEN`
7. 部署 Worker：
   `npx wrangler deploy`

部署成功后，终端会显示 Worker 地址，例如：
`https://juxin-real-estate-ai.<你的Cloudflare子域>.workers.dev`

## 连接网页

1. 打开居信地产 AI 精修工作台：
   https://18436002821.github.io/zhi-yuheng-portfolio/real-estate-ai-studio/
2. 导入房源照片，点击「AI 一键精修全部照片」。
3. 首次使用时，按提示输入上一步生成的 Worker 地址和工作台访问码。
4. 连接信息只保存在当前浏览器本地；需要更换时，点击 AI 说明旁边的「重置 AI 连接」。

## 技术说明

- 模型：`@cf/black-forest-labs/flux-2-klein-4b`
- 模型能力：图生图编辑；固定 4 步推理；本工作台每次提交 1 张照片，批量时逐张处理。
- 输入照片在浏览器中缩放到最长边不超过 1920px，再以 JPEG 上传。
- Worker 不把照片写入 R2、KV 或数据库；处理结果直接返回浏览器。
- 仅允许来自 `https://18436002821.github.io` 的跨域请求。
- API 访问码由 Cloudflare Worker Secret 保存，不放进网页源代码。
- 照片会发送至 Cloudflare Workers AI 进行推理。Cloudflare 表示 Workers AI 客户内容不会提供给其他 Cloudflare 客户，也不会用于训练或改进其 AI 服务，除非获得明确同意。

## 房源照片的重要提醒

模型会尽力保留原始户型、家具、墙体、门窗和视角，但任何生成式图像模型都不能保证像素级不改变现场细节。请务必用原图核对窗景、家具、设备、空间尺寸和房屋实际状况；对外发布房源时，不要用 AI 生成结果掩盖真实瑕疵或误导看房者。

## API

- `GET /api/health`：检查访问码与 Workers AI 绑定。
- `POST /api/retouch`：接收一张照片，执行 FLUX.2 Klein 4B 图生图精修，返回图片二进制。
