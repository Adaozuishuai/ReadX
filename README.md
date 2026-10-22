<p align="center">
  <img src="windows/apps/web/public/icon-512.png" alt="ReadX icon" width="88" height="88">
</p>

<h1 align="center">ReadX</h1>

<p align="center"><strong>把论文读懂，把研究过程连起来。</strong><br>本地优先的论文阅读、翻译与研究工作区 · Windows / macOS</p>

<p align="center">
  <a href="https://github.com/Leechion/ReadX/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Leechion/ReadX?style=flat-square&color=2f6f59"></a>
  <a href="https://github.com/Leechion/ReadX/actions/workflows/release-windows.yml"><img alt="Windows build" src="https://img.shields.io/github/actions/workflow/status/Leechion/ReadX/release-windows.yml?branch=main&label=Windows&style=flat-square"></a>
  <a href="https://github.com/Leechion/ReadX/actions/workflows/build-macos.yml"><img alt="macOS build" src="https://img.shields.io/github/actions/workflow/status/Leechion/ReadX/build-macos.yml?branch=main&label=macOS&style=flat-square"></a>
</p>

<p align="center"><a href="#中文">简体中文</a> · <a href="#english">English</a> · <a href="windows/README.md">使用与开发文档</a></p>

## ReadX 宣传视频

https://github.com/user-attachments/assets/1b377a2a-c36d-4e51-9923-feb28d1912d2

<p align="center"><a href="docs/media/ReadX.mp4">下载原始高清 MP4</a> · <a href="docs/media/ReadX-宣传片-绿色版.mp4">下载绿色版 MP4</a></p>

## 中文

ReadX 是一个面向科研阅读的桌面工作区：把论文导入书库，在本机完成识别与翻译，然后在同一个窗口里逐页双语阅读、高亮批注、向 AI 助教提问、把精读拆成五个章节逐项梳理，最后将阅读成果整理成学术演示稿。论文文件与阅读资料优先保存在本机。

### 一眼看懂 ReadX

![ReadX 封面：读论文、做标注、写想法，也都在一处](docs/images/promo/01-cover.jpg)

读论文、做标注、写想法，都在一处。从论文入库到逐页阅读、精读与汇报，ReadX 把研究过程的每一步自然连起来：

![ReadX 工作流：导入论文 → 识别与翻译 → 双语阅读 → AI 精读 → 汇报输出](docs/images/readx-workflow.svg)

### 功能巡览

#### 01 · 文献库：一个课题一个书库，读到哪儿一目了然

论文集中管理，阅读状态、标签与阅读计划都能随时查看。

- **按课题建库**：左栏提供全部文档、书架、收藏、阅读状态与阅读计划入口，一个课题对应一个书库。
- **卡片式论文列表**：每张卡片显示文件格式、翻译状态、标签与重新翻译入口；顶部统计在库、翻译中与已翻译数量。
- **检索与推荐**：搜索框按标题、作者或标签过滤；右侧「每日论文推荐」汇总 MICCAI、CVPR、ICCV、ECCV、NeurIPS、ICLR、AAAI、TMI 等venue 的新论文。

#### 02 · 导入论文：把论文放进来，阅读从这里开始

![导入论文：拖拽 PDF / EPUB 或按 arXiv 编号、DOI、URL 导入](docs/images/promo/03-import.jpg)

导入 PDF 或 EPUB，识别内容后即可加入你的阅读书库。

- **多种导入方式**：拖拽文件到导入区，或按 arXiv 编号、DOI、URL 直接拉取论文。
- **三步流程透明可见**：选择文件 → 入库并翻译 → 项目目录与译文，导入前即告知限制（PDF 最大 512 MB，扫描版需 OCR；EPUB 最大 100 MB）。
- **本机保存**：论文入库后保存在本机，并自动进入翻译处理队列。

#### 03 · 处理进度：每一步处理进度，都清楚看得见

![处理进度：OCR、翻译、渲染与论文记忆四段流水线](docs/images/promo/04-processing.jpg)

OCR、翻译、渲染与论文记忆状态分开展示，处理过程更明白。

- **四段流水线**：OCR → 翻译 → 渲染 → 论文记忆依次执行，每一步显示「处理中 / 等待中」状态。
- **按页计数**：翻译进度与渲染进度以页为单位实时累计，有效结果日志记录每步的开始与完成时间。
- **多视角查看**：概览、进度、文件三个页签切换，处理可随时取消或重试。
- **重新翻译不必重新导入**：书库里的「重新翻译」优先复用已有的识别结果，只重跑翻译；如果这篇论文没有可复用的识别结果（旧版本导入、识别产物已被清理），它会**自己重新识别再翻译**，并把更新后的逐页文本与版式写回书库。前提（模型与 PaddleOCR 令牌）缺失时会立刻说清缺什么，而不是让人重新导入——那会丢掉批注、精读笔记与阅读进度。

#### 04 · 双语阅读：原文译文并排，逐页对照着读

![双语阅读：左栏章节目录，中间原文页，右侧译文页](docs/images/promo/05-bilingual-reading.jpg)

双栏论文也按原文版面阅读，翻译内容与页面位置对应。

- **并排对照**：原文页与译文页左右并排、逐页同步翻页（上一页 / 下一页），保留双栏版面、公式与图表位置。
- **章节直达**：左栏章节目录（Introduction、Related Work、Preliminaries…）点击即跳转对应页面。
- **三种视图**：顶栏可在双语、仅原文、仅译文之间切换，并可导出带批注的 PDF。

#### 05 · 高亮与批注：选中一段或一个公式，标注后就能继续问

![高亮与批注：选中段落高亮、整段翻译并送入 AI 助教](docs/images/promo/06-highlights.jpg)

高亮论文内容，直接翻译整段，或带着上下文询问 AI 助教。

- **选中即标注**：框选段落或公式即可高亮，重点内容随论文保存。
- **标注即入口**：选中文本可整段翻译，或一键送入右侧 AI 助教面板继续追问。
- **批注可回溯**：高亮与批注跟论文一起留在本机，下次打开仍在原页原位置。

#### 06 · AI 助教：围绕论文上下文，继续问到真正弄懂

![AI 助教：回答附带 Page / Fig / Sec 页码线索](docs/images/promo/07-ai-assistant.jpg)

回答结合当前论文与页码线索，帮助你沿着研究问题深入阅读。

- **论文上下文问答**：提问默认附带当前论文内容，回答自动标注出处（Page 1-3、Fig. 1、Sec. 5 等），可点击回原文核对。
- **顺着线索追问**：从一段解释追到具体页、具体公式，直到真正弄懂为止。
- **强度可调**：模型与推理强度（如 High）随时切换，快查与深读各得其所。

#### 07 · 精读五重奏：把精读拆成五步，逐项梳理研究脉络

![精读五重奏：实验动机、方法公式、实验配置、结果分析、代码复现五个独立章节](docs/images/promo/08-deep-reading.jpg)

从实验动机、方法公式到结果分析与代码复现，分节推进。

![精读五重奏结构图](docs/images/readx-quintet.svg)

- **五个独立章节**：实验动机、方法公式、实验配置、结果分析、代码复现，各自独立生成、独立保存、可单独重新生成。
- **带出处的分析**：每节内容附页码与公式引用（如 Page 1、Page 3），结论可逐条回原文核对。
- **可导出积累**：完成的章节可导出，逐步沉淀成该课题的结构化精读笔记。

#### 08 · 论文演示稿：从论文到汇报，边生成边预览

![论文演示稿：选择书库论文，右侧实时预览幻灯片](docs/images/promo/09-ppt-studio.jpg)

选择书库论文，生成结构清晰、可继续编辑的学术演示文稿。

- **从书库直达汇报**：在演示稿工作区左侧挑选论文，一键生成整套学术 PPT。
- **边生成边预览**：右侧实时预览当前幻灯片，底部缩略图条显示全部页（如 1 / 12）与生成进度。
- **模板可换**：内置主题与自定义模板可选，生成的幻灯片可继续编辑后用于组会或汇报。

#### 09 · AI 助手设置：连接你常用的模型，按自己的方式阅读

![AI 助手设置：多模型服务商预设、模型与推理强度配置](docs/images/promo/10-ai-settings.jpg)

配置模型与推理强度，让论文问答和精读流程适配你的工作习惯。

- **多模型预设**：内置 DeepSeek、OpenAI、Anthropic、OpenRouter、通义千问、智谱 GLM、月之暗面、火山引擎等常用服务商，也支持自定义服务端点。
- **CLI 直连**：Codex Desktop / CLI、Claude Code CLI、Kimi Code CLI 等可直接连接；Codex Desktop 用户登录后即可使用，无需单独管理密钥。
- **按流程配置**：模型、推理强度等设置保存在本机，翻译、问答与精读可各用各的组合。

#### 10 · 查找、检索与对照：把散在各篇里的东西找出来

论文多了以后，真正的成本是「我记得在哪见过」。这一组能力都围绕「找到并回到原文」：

- **文档内查找**：阅读器按 Ctrl/Cmd+F 打开查找条，命中计数、上下条跳转，命中处直接在页面上标出（仅译文模式查译文，其余查原文）。
- **全库全文检索**：书库搜索框可切到「全文」，在已索引的逐页正文里检索，结果显示论文、页码与上下文片段，点一下跳到那一页并自动定位到命中处。结果头部会说明索引覆盖（未翻译且没在阅读器里打开过的论文、整页扫描的论文不在索引内）。
- **跨文献对照**：从「对照」工作区选 2–4 篇，把「精读 · 实验配置」的七个维度（研究对象与数据、研究设计与条件、实施流程、分析方法、对照或基线、评价标准、结果）并排摊开，每格都带页码可回原文；还没抽取的论文可以就地生成。表里区分「未抽取」与「论文未提及」两种状态。

#### 11 · 引用与统计：把阅读沉淀成可用的材料

- **书目导出**：阅读器工具栏「引用」或书库「导出书目」，导出 BibTeX / RIS（单篇、按书架或整库）。下载前会先告诉你条目类型是怎么判定的：按会场名识别会议/期刊，判断不出来时用 `@misc` 并原样带出会场名，不替作者猜；作者姓名按题录原样输出。
- **引用关系**：阅读器工具栏「引用网络」看这篇论文与本库其它论文的引用关系（哪几篇是它的参考文献、本库哪几篇引用了它），数据来自 OpenAlex，结果缓存 7 天。只有题录里有 DOI 的论文可查，这一点会在界面上写明。
- **书库统计**：阅读日历页底部给出在库/在读/已精读、最近 7 天与 30 天在读篇数、批注与精读产出、各处理阶段（OCR / 翻译 / 渲染）的耗时中位数与每页耗时，以及年份、书架与主题分布。不报「读了多久」——页面停留时长没有采集，不编。

#### 12 · 知识图谱：跨文献的概念连成一团可旋转的点云

![知识图谱：双环同心点云，内环是跨文献共享的实体，外圈是单篇实体，最外层是论文](docs/images/promo/11-knowledge-cloud.png)

把每篇论文抽出的实体与关系合并成一张跨文献图谱，用**双环同心点云**呈现：

- **越靠圆心＝被越多篇论文共享**：核心环是被多篇共享的实体（真正沉淀下来的共识），外圈是只出现在一篇里的实体，最外层是论文本身——每篇论文连到它包含的实体。
- **每个点都能点开**：拖拽旋转、滚轮缩放、右键平移，可开自转；悬停一个点会点亮它的全部连线并放大邻居；点标签或点，右侧面板列出关系与**逐字、带页码的原文依据**，点依据回到阅读器对应页。搜索与类型筛选会就地重新收敛。
- **如实披露**：状态行给出跨文献实体数与关系边数；关系来自 AI 抽取、按论文逐篇进行，没抽取过的论文不在图里；点或边超过绘制上限时会说明只画了前多少条。
- **对照表视图保留**：图形负责「看形状」，矩阵负责「读交集」（共有 / 仅各篇逐条列清楚），两种问题分别回答。
- **实现说明**：点云用 three.js（WebGL）渲染，按主题切换混合模式（深色底走加色发光，浅色与纸张底走常规混合），并且随图谱工作区懒加载——不打开图谱就不会下载这部分代码。

### 下载与开始使用

从[最新 Release](https://github.com/Leechion/ReadX/releases/latest)下载 Windows 或 macOS 安装包。启动后，在 **AI 助手设置**中选择模型服务并配置连接；Codex Desktop 用户可先登录 Codex，再从 ReadX 中连接。

#### macOS 首次启动

将 `ReadX.app` 拖到“应用程序”文件夹后，如果 macOS 拦截首次启动，在“终端”中依次执行：

```sh
sudo spctl --master-disable
xattr -cr /Applications/ReadX.app
```

第一条命令会全局关闭 Gatekeeper，降低 macOS 对应用的安全检查。请只对从可信来源下载并确认过的 ReadX 安装包执行；首次打开后，可用 `sudo spctl --master-enable` 重新启用 Gatekeeper。`sudo` 提示输入密码时，终端不会显示输入内容。

详细的安装、AI 配置、数据存放位置和故障排查说明见 [Windows 使用文档](windows/README.md)；macOS 构建说明见 [macOS 文档](macos/README.md)。

### 隐私说明

ReadX 将论文及阅读资料保存在本机。使用 AI 翻译或问答时，相关文本或图片会发送给你选择的模型服务。API 密钥保存在本机配置中，请勿提交到仓库。

## English

ReadX is a desktop workspace for research reading. Import papers, let recognition and translation run on your machine, then read bilingually page by page, highlight and annotate, ask a paper-aware AI assistant, split deep reading into five focused passes, and turn the results into an academic presentation. Papers and reading data stay on your computer by default. The numbered items below match the screenshots in the Chinese tour above.

### Features

1. **Library (01)** — One library per project with shelves, favorites, reading status, reading plans, card-style paper list, and a daily paper recommendation panel.
2. **Import (02)** — Drag in PDF / EPUB or fetch by arXiv ID, DOI, or URL; a three-step dialog shows limits and what happens next.
3. **Processing (03)** — A visible OCR → translation → rendering → paper-memory pipeline with per-step status, page-level progress, and a result log. "Re-translate" in the library reuses the stored OCR result when there is one and **re-runs OCR itself when there is not**, writing the refreshed page text and layout back to the library — it never sends you off to re-import, which would cost your annotations, notes, and reading progress.
4. **Bilingual reading (04)** — Original and translated pages side by side with synced paging, section navigation, preserved two-column layout, and annotated-PDF export.
5. **Highlights & notes (05)** — Highlight passages and equations, translate a whole paragraph, or send the selection to the assistant with context; annotations persist locally.
6. **AI assistant (06)** — Paper-context Q&A whose answers cite pages, figures, and sections so every claim can be checked against the source.
7. **Deep-reading quintet (07)** — Five independently generated and saved sections: motivation, methods and equations, experimental setup, results analysis, and code reproduction.
8. **Presentation studio (08)** — Pick a paper from the library and generate an editable academic slide deck with live preview, thumbnails, and built-in or custom templates.
9. **AI settings (09)** — Presets for major providers plus custom endpoints and CLI connections (Codex, Claude Code, Kimi Code), with per-flow model and reasoning-effort choices.
10. **Find, search & compare (10)** — In-document find with hit counts and next/previous (Ctrl/Cmd+F); library-wide full-text search over indexed page text with snippets, coverage disclosure, and jump-to-page; a cross-paper comparison table for 2–4 papers built from their experimental-setup extractions, with per-cell page links and an explicit "not extracted" vs "not reported" distinction.
11. **Citations & stats (11)** — BibTeX / RIS export (single paper, shelf, or whole library) that discloses how each entry type was inferred; an OpenAlex-backed citation network showing which library papers this one cites and which cite it; and library statistics covering reading activity, annotations, per-stage processing durations, and year/shelf/topic distribution. Stay time is deliberately not reported — it is not collected.
12. **Knowledge graph (12)** — cross-paper entities and relations rendered as a dual-ring point cloud: shared entities sit nearest the center, single-paper entities around them, papers on the outer shell, all interlinked. Drag to rotate, scroll to zoom, hover a node to light up every link, click for relations with verbatim, page-anchored evidence that jumps back to the source page. A matrix view stays available for reading exact overlaps. Rendered with three.js (WebGL), lazy-loaded with the graph workspace.

### Download

Download the latest Windows or macOS installer from [GitHub Releases](https://github.com/Leechion/ReadX/releases/latest). Configure an AI provider in **AI Assistant Settings** before using translation or AI features. See the [Windows guide](windows/README.md) for setup details.

### Privacy

Papers, annotations, reading progress, and notes are stored locally. When you use AI translation or Q&A, the relevant text or images are sent to the model service you selected. API keys stay in local configuration — never commit them.

### Build from source

Windows development requires Node.js 22.8+ and Go 1.27+:

```powershell
cd windows
npm ci
npm run dev
```

For macOS development and packaging, see [`macos/README.md`](macos/README.md).

### License

ReadX is released under the [MIT License](LICENSE). Third-party components retain their respective licenses.

---

<p align="center"><sub>ReadX · Research Reading Workspace · Windows and macOS</sub></p>
