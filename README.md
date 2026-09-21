# FlashTrans · 中英互译

极简蓝白风格的中英互译工具。输入或**说出**中文自动译为英文，输入或说出英文自动译为中文，译力求**信、达、雅**。

![FlashTrans 截图](docs/screenshot.png)

**在线使用**：https://www.flashtrans.xyz/

## 功能

- 上下双栏：上译文、下输入，流式逐字出译文
- 自动识别翻译方向（中 ⇄ 英），界面实时显示当前方向
- **语音输入**：长按翻译按钮启动豆包流式语音识别 2.0，说话松手自动出译文（单击按钮仍为普通翻译）；桌面端与移动端均可使用
- 输入区：粘贴 / 复制 / 清空；输出区：一键复制
- `Ctrl / ⌘ + Enter` 快捷翻译，移动端自适应，PWA 可添加到主屏幕

## 架构

纯静态前端 + Cloudflare Worker 代理：

```
浏览器 (GitHub Pages)  ──►  Cloudflare Worker  ──►  DeepSeek API / 火山引擎 ASR
     index.html              api.flashtrans.xyz        deepseek-chat
     style.css               POST /   翻译: 限流/选提示词/转发     豆包流式语音识别 2.0
     app.js                  WSS /asr 语音: PCM 转发/协议编解码
                            密钥与提示词均为
                            Cloudflare Secrets
```

- **前端**（仓库根目录）：零构建纯静态，由 GitHub Pages 直接托管，支持 PWA。
- **后端**（`worker/`）：Cloudflare Worker，绑定自定义域名 `api.flashtrans.xyz`（同时保留默认 workers.dev 路由）。
  - `POST /`：翻译代理——按 IP 限流（每分钟 20 次 / 每天 200 次）、输入截断（8000 字符）、方向检测、转发 DeepSeek 并透传 SSE 流；
  - `WSS /asr`：语音代理——浏览器发裸 PCM（16k/16bit/单声道），Worker 完成火山引擎鉴权与二进制协议编解码；每 IP 同时 1 会话、单会话 60s 硬顶、每 IP 每日 30 分钟语音配额。

## 安全说明

**本仓库不含任何 API Key 与翻译提示词明文。** DeepSeek API Key、火山引擎 DOUBAO_API_KEY 和两条翻译提示词均以 Cloudflare Secrets 加密注入 Worker（`wrangler secret put`），源码中仅有 `env.*` 引用；前端代码中没有任何机密信息。

## 本地开发

```bash
# 前端（任意静态服务器）
python -m http.server 8000

# Worker
cd worker
npm install
npx wrangler dev
```

## 部署

```bash
# 1. 前端：推送到 main 后，仓库 Settings → Pages → Source 选 main / (root)

# 2. Worker
cd worker
npx wrangler login
npx wrangler deploy

# 3. 注入机密（不会进入 git）
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DOUBAO_API_KEY
npx wrangler secret put PROMPT_ZH2EN    # 粘贴中→英提示词
npx wrangler secret put PROMPT_EN2ZH    # 粘贴英→中提示词

# 4. 将 app.js 中 WORKER_URL 改为部署后的 Worker 地址
```

## License

MIT
