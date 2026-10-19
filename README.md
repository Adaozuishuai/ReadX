<p align="center">
  <img src="windows/apps/web/public/icon-512.png" alt="ReadX app icon" width="112" height="112">
</p>

<h1 align="center">ReadX</h1>
<p align="center"><strong>Research papers, read with context.</strong><br>把论文读懂，也把图表、译文与研究思路连起来。</p>

<p align="center">
  <a href="https://github.com/Leechion/ReadX/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Leechion/ReadX?display_name=tag&style=flat-square&color=276653"></a>
  <a href="https://github.com/Leechion/ReadX/actions/workflows/release-windows.yml"><img alt="Windows release" src="https://img.shields.io/github/actions/workflow/status/Leechion/ReadX/release-windows.yml?branch=main&label=Windows%20release&style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-276653?style=flat-square&logo=windows&logoColor=white">
  <img alt="Stack" src="https://img.shields.io/badge/React%20%2B%20Go%20%2B%20Electron-Research%20Workspace-496f61?style=flat-square">
</p>

<p align="center">
  <a href="#中文">简体中文</a> · <a href="#english">English</a> · <a href="windows/README.md">开发与详细使用说明</a>
</p>

<p align="center">
  <a href="https://github.com/Leechion/ReadX/releases/latest"><strong>下载 Windows 版</strong></a>
</p>

---

<a id="中文"></a>

## 从导入到理解，一处完成

ReadX 是面向科研论文的本地阅读工作区。导入 PDF 后，ReadX 识别页面与段落、翻译并保留原有排版；阅读时可在原文和译文间对照，再用 AI 助教和精读五重奏梳理论文的方法、实验与结果。

<p align="center">
  <img src="docs/images/readx-workflow.svg" alt="ReadX 从论文导入、OCR 和翻译，到双语阅读、精读与导出的工作流程" width="100%">
</p>

### 主要功能

| 阅读与理解 | 研究与整理 |
| --- | --- |
| **PDF / EPUB 阅读**：目录导航、阅读位置恢复、选区批注；PDF 支持原文、译文和双语对照。 | **精读五重奏**：实验动机、方法公式、实验配置、结果分析、代码复现分别分析、分别保存。 |
| **保留版式的翻译**：识别段落和版面结构，译文按原页位置呈现；可重新翻译书库中的论文。 | **图表融入分析**：识别并裁切论文中的图表，在分析相应章节时把相关图表直接放入正文。 |
| **AI 助教**：围绕当前论文提问；对话按论文保存在本机。 | **模型可选**：配置兼容 API，或连接已登录的 Codex Desktop；可选择可用模型和推理强度。 |
| **译文 PDF**：生成保留原页面布局的译文 PDF，便于阅读与分享。 | **本地优先**：论文文件、阅读进度、批注和精读记录保存在本机。 |

## 精读五重奏

五个部分可以单独生成，并行处理；分析会复用导入时整理的论文上下文。图表与对应章节一起进入分析正文，公式和结果表格保留为可读格式。

<p align="center">
  <img src="docs/images/readx-quintet.svg" alt="精读五重奏的五个分析部分" width="100%">
</p>

## 下载与开始

**当前提供 Windows 桌面版。** 在 [最新 Release](https://github.com/Leechion/ReadX/releases/latest) 下载 `ReadX-Setup-*.exe`，运行安装程序后从桌面或开始菜单启动。

首次使用请在 **AI 设置**中配置翻译和问答所用的服务。若使用 Codex Desktop，先在 Codex 中登录，再在 ReadX 的 AI 设置中选择 Codex。不同服务的配置方式见[详细指南](windows/README.md#ai-接入)。

> v0.1.3 首次加入应用内检查更新。已安装 v0.1.2 或更早版本的用户，请先从 Release 页面安装一次 v0.1.3；后续版本可以从应用内检查和安装。

## 更新内容 · v0.1.3

- 新增应用内检查更新，可查看版本说明并选择立即更新或暂不更新。
- 精读五重奏支持五部分并行生成，复用导入阶段建立的论文上下文。
- 书库支持重新翻译；阅读器支持连续滚动和双语对照跳转。
- 改进 Windows 导入、OCR 与翻译进度对应关系，并修复精读表格布局问题。

更多细节见 [v0.1.3 Release](https://github.com/Leechion/ReadX/releases/tag/v0.1.3)。

## 数据与隐私

ReadX 的论文、阅读位置、批注和精读内容保存在本机。使用云端模型时，相关论文文本或提问内容会发送给你在 AI 设置中选择的服务；请在使用前查看该服务的隐私政策。API Key 保存在本机配置中，请勿将密钥提交到仓库。

## 开发者

Windows 开发环境需要 Node.js 20.19+ 和 Go 1.27+：

```powershell
cd windows
npm ci
npm run dev
```

生产构建：

```powershell
npm run build
```

完整的 Windows 功能、AI 接入、数据位置和构建说明见 [`windows/README.md`](windows/README.md)。

## 鸣谢

感谢开源文档处理、OCR、PDF 渲染和论文元数据项目的维护者。第三方组件及许可信息随仓库相应目录提供。

---

<a id="english"></a>

## English

ReadX is a local-first research reading workspace. Import a PDF, read the source alongside its translation, ask an AI tutor questions about the paper, and build a structured understanding with the five-part deep-reading workflow.

### What you can do

- Read PDF and EPUB papers with table-of-contents navigation, saved reading position, and annotations.
- Translate PDFs while preserving page layout, then compare source and translation side by side.
- Ask questions in a paper-specific AI chat and choose from the models available to your configured provider or signed-in Codex Desktop.
- Analyze motivation, methods and equations, experimental setup, results, and reproduction as five independent sections.
- Bring figures and tables into the relevant analysis section, and export translated PDFs or reading notes.
- Keep papers, notes, annotations, and reading progress on your computer.

### Download

Download the Windows installer from [the latest GitHub Release](https://github.com/Leechion/ReadX/releases/latest). Configure an AI provider in **AI Settings** before using translation or AI features. See the [Windows guide](windows/README.md) for setup details.

### Build from source

Requires Node.js 20.19+ and Go 1.27+.

```powershell
cd windows
npm ci
npm run dev
```

---

<p align="center"><sub>ReadX · Research Workspace · Windows</sub></p>
