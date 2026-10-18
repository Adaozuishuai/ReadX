<p align="center">
  <img src="windows/apps/web/public/icon-512.png" alt="ReadX 图标" width="120" height="120">
</p>

<h1 align="center">ReadX · Research Workspace</h1>

<hr>

<p align="center">
  <a href="#zh">简体中文</a> | <a href="#en">English</a>
</p>

<p align="center">
  <a href="windows/README.md"><img alt="Windows" src="https://img.shields.io/badge/Windows-supported-2b6651?style=flat-square&logo=windows&logoColor=white"></a>
  <a href="macos/README.md"><img alt="macOS" src="https://img.shields.io/badge/macOS-supported-2b6651?style=flat-square&logo=apple&logoColor=white"></a>
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react&logoColor=white">
  <img alt="Go" src="https://img.shields.io/badge/Go-1.27-00add8?style=flat-square&logo=go&logoColor=white">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848f?style=flat-square&logo=electron&logoColor=white">
  <img alt="Documents" src="https://img.shields.io/badge/PDF%20%2B%20EPUB-reading-2b6651?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/Leechion/cbct-reading"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Leechion/cbct-reading?style=flat-square&color=2b6651&logo=github"></a>
  <img alt="Codex Desktop" src="https://img.shields.io/badge/AI-Codex%20Desktop-2b6651?style=flat-square">
  <img alt="Local first" src="https://img.shields.io/badge/data-local%20first-2b6651?style=flat-square">
</p>

<a id="zh"></a>

> 面向科研阅读的本地工作区：阅读 PDF 与 EPUB、对照原文翻译、整理图表，并用 AI 助教完成论文的**精读五重奏**——实验动机、方法公式、实验配置、结果分析和代码复现。图表会结合分析归入相关步骤，精读内容按节保存，方便继续阅读与追问。

<a id="en"></a>

<p align="center"><em>A local research workspace for reading PDF and EPUB papers, comparing translations with the source, organizing figures and tables, and studying each paper through five focused steps: motivation, methods and equations, experimental setup, results, and reproduction. Relevant figures are placed alongside their analysis, while notes are saved section by section for follow-up reading.</em></p>

<p align="center">
  <a href="windows/README.md">Windows 使用说明</a> ·
  <a href="macos/README.md">macOS 使用说明</a> ·
  <a href="https://github.com/Leechion/cbct-reading">GitHub 仓库</a>
</p>

## 功能一览

- **论文阅读**：阅读 PDF 与可重排 EPUB，支持目录导航、阅读位置恢复、选区批注、段落提问与双语阅读。
- **精读五重奏**：按五个研究步骤逐节生成和保存分析；方法公式以 LaTeX 排版，结果可保留原表格，复现计划可整理为任务清单。
- **图表结合分析**：识别图表候选并从原 PDF 裁切；可校正或补选图表。AI 分析时将相关图表放进对应步骤和小节正文。
- **AI 助教**：对话按论文保存在本机，支持停止、重新回答、公式和代码排版，以及从回答定位出处。可选择 Codex Desktop 中可用的模型与推理强度。
- **本机数据**：论文、阅读记录与批注保存在本机。AI 请求发送到当前配置的渠道；Codex 接入使用已登录的 Codex Desktop，不需要另装 CLI。

## 最近更新（2026-10-18）

- **品牌与图标**：应用、网页标题、Windows 桌面快捷方式和启动器统一使用 ReadX；应用图标更新为 Figma 设计的绿色书本与 AI 星芒标志。
- **Codex AI 助教**：直接连接已登录的 Codex Desktop 程序，动态读取可用模型及其推理强度；选择会保存并用于后续对话和精读，无需另装 Codex CLI。
- **对话工作区**：采用 Codex 风格的输入与模型控制布局；支持按论文保存多组对话、停止和重试、原文引用定位、文本附件与语音输入。
- **精读五重奏**：新增逐页图像阅读与复核、长论文分层串联和分节增量保存。精读正文以可读 Markdown 为主，结构化字段独立整理，避免公式或正文因 JSON 解析失败而整体丢失。
- **图表分析**：改进双栏图注、矢量图形和多面板边界识别；支持原页补选、校正和忽略误识别。AI 分析时把选中的真实图表嵌入对应步骤与小节正文。

## 快速开始

需要 Node.js 20.19+ 和 Go 1.27+。Windows：

```powershell
cd windows
npm ci
npm start
```

安装依赖后，也可以双击 `windows/启动 ReadX.cmd` 启动。macOS 请按 [macOS 使用说明](macos/README.md) 中的步骤运行。

开发与构建：

```powershell
cd windows
npm run dev
npm run build
```

## 本机数据

论文副本默认位于仓库根目录的 `library/`；配置位于 `app/config.json`，阅读数据库位于 `app/data/v2/reader.db`。本机论文、配置和数据库不随源码提交。请勿将真实 API Key 提交到 Git。

## 文档

- [Windows 版完整功能、AI 接入与开发说明](windows/README.md)
- [macOS 版使用说明](macos/README.md)
