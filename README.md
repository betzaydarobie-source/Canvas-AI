# Canvas-AI · 无限画布

> 一个 AI 多模态创作桌面工具，三种模式自由切换：简单生图、Midjourney 命令式聊天、ComfyUI 风的节点式工作流。

[![Version](https://img.shields.io/badge/version-1.0.4-blue.svg)](https://github.com/betzaydarobie-source/Canvas-AI/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)]()

> 🆕 **第一次用？** 跟着 [👉 新手完整指南](./新手完整指南.md) 一步一步来，**10 分钟从零开始跑出第一张图**（含截图）

---

## ✨ 三种模式

### 🎨 无限画布
最简单的 AI 文生图工具。在无限画布上自由生成、移动、缩放图片。支持 30+ 模型（GPT Image / Flux / Seedream / Gemini / Grok / MJ / Ideogram / Qwen 等）。

### 🐦 MJ Chat
Discord 风格的 Midjourney 命令式聊天界面。支持全部 25 条官方命令（/imagine、/describe、/blend、Vary Region 等），任务可断点恢复。

### 🔗 工作流（专业模式）
ComfyUI 风的节点式编辑器：
- 双击空白添加节点（图像生成 / 语言大模型 / 文本节点 / 上传图片）
- 每个节点带内嵌表单，生成后自动转换成结果节点
- "基于此图再生成"自动建立连线，可视化创作血缘
- 工作流 JSON 导入/导出，便于备份和分享

---

## 🔌 配套 API 服务：yC API 中转站

Canvas-AI 调用的是 **OpenAI 兼容协议**，默认指向我们自营的中转站 **[yC API](https://www.yccloudapi.online)** —— 一个国内直连的 AI 模型聚合中转。

### ✨ 为什么用 yC API

| 优势 | 说明 |
|------|------|
| 🎯 **30+ 模型一站式** | GPT Image 1/2 · Flux Pro 全系 · Seedream 3.0~5.0 · Gemini 2.5 Flash / 3 Pro · Grok 3/4 · Midjourney · Ideogram V1/V2/V3 · Qwen Image Max · DeepSeek · Claude Sonnet/Opus 4.5 |
| 🌏 **国内直连** | 无需科学上网，免代理直接调用 |
| 💳 **按量计费** | 充值即用，不绑定订阅，没用完不过期 |
| 🔄 **高可用多线路** | 自动切换备用线路，单点异常不影响业务 |
| 🛠️ **OpenAI 兼容** | 用现有 SDK 改 `base_url` 即可接入，无侵入 |

### 🚀 快速接入

1. **[点这里注册 yC API 账号 →](https://www.yccloudapi.online)**
2. 充值（有新人额度可以先试）
3. 在控制台生成 API Key（`sk-` 开头）
4. 在 Canvas-AI 左下齿轮 ⚙️ 里粘贴 Key → 保存

> Canvas-AI 也支持其他任意 OpenAI 兼容的 API 中转。直接改 `.env` 里的 `API_BASE` 指向你想要的端点即可（例如 OpenAI 官方、Claude API、自建 LiteLLM 等）。

---

## 🚀 快速上手

### 桌面应用（推荐）

直接到 [Releases](https://github.com/betzaydarobie-source/Canvas-AI/releases) 下载：
- **macOS**：`无限画布-x.x.x-arm64.dmg`（Apple Silicon）/ `无限画布-x.x.x-x64.dmg`（Intel）
- **Windows**：`无限画布-Setup-x.x.x.exe`（安装版）/ `无限画布-Portable-x.x.x.exe`（免安装）

> macOS 第一次打开提示"已损坏"？终端运行：
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/无限画布.app
> ```

### 本地开发

```bash
git clone https://github.com/betzaydarobie-source/Canvas-AI.git
cd Canvas-AI
npm install

# 配置 API Key（默认指向 yC API：https://www.yccloudapi.online）
cp .env.example .env
# 编辑 .env，填入你在 yC API 注册后拿到的 sk- 开头的 Key
# 也可以改 API_BASE 用其他 OpenAI 兼容端点

# 启动浏览器版
npm start
# → 打开 http://localhost:3000

# 或启动 Electron 桌面版
npm run electron

# 打包安装包
npm run dist:mac    # macOS dmg
npm run dist:win    # Windows nsis + portable exe
```

---

## 📖 文档

| 文档 | 适合谁 |
|------|------|
| 🆕 **[新手完整指南](./新手完整指南.md)** | 第一次用 · 含截图 · 从注册到出图全流程 |
| 📖 **[使用说明](./使用说明.md)** | 已经会用 · 详细查阅每个功能 |

完整使用说明包含：
- 每种模式的详细操作流程
- 30+ 模型支持的比例 / 分辨率对照表
- 25 条 MJ 命令完整列表
- 快捷键速查
- 常见问题（Mac quarantine、Windows NSIS 错误、模型 snap 行为等）

---

## 📦 技术栈

- **前端**：原生 HTML + JS + Canvas 2D（无框架，单文件 7K+ 行）
- **后端**：Node 18+ 内置 HTTP server，转发到 OpenAI 兼容的 API
- **桌面**：Electron 31 + electron-builder（自动 ad-hoc 签名）
- **持久化**：IndexedDB（图片、节点、连线、聊天记录、诊断日志）

---

## 🗂️ 版本历史

| 版本 | 主要变化 |
|------|----------|
| **v1.0.4** | ComfyUI 风节点式工作流 / 文本节点 / LLM 节点 / 工作流 JSON 导入导出 / `/api/llm` 端点 |
| **v1.0.3** | GPT Image 2 修复多模态参考图路由 / 桌面应用打包脚本 / 诊断面板 |
| **v1.0.2** | Windows 深色模式 select 字体修复（自定义 dropdown） |
| **v1.0.1** | 移除已下架的 DALL·E 3 / 暗色模式 Discord 蓝灰主题 |
| **v1.0.0** | MJ 9 个端点全实现 / 比例-模型联动锁定 / IndexedDB 画布持久化 |

> **注**：v1.0.0 ~ v1.0.2 的安装包未保留发布；v1.0.3 已包含所有这些版本的修复，建议直接使用最新版。

---

## 🔒 隐私与安全

- API Key **只存在你本机**的 localStorage 或 .env 文件中，不上传任何服务器
- 所有请求通过本地 server 转发（避免浏览器 CORS + 隐藏 key）
- 画布内容、聊天记录、诊断日志全部用 **IndexedDB 本地存储**
- 桌面应用是离线工作的纯前端 + 本地代理结构

---

## 🔗 相关链接

- 🌐 **官方网站**：[https://www.yccloudapi.online](https://www.yccloudapi.online)
- 📖 **使用文档**：[使用说明.md](./使用说明.md)
- 🐛 **Bug 反馈**：[GitHub Issues](https://github.com/betzaydarobie-source/Canvas-AI/issues)
- 📦 **下载安装包**：[GitHub Releases](https://github.com/betzaydarobie-source/Canvas-AI/releases)

---

## 📜 License

[MIT](LICENSE) © 2025-2026 · API 服务由 [yC API](https://www.yccloudapi.online) 提供支持
