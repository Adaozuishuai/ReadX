# CBCT 论文每日精读助手 — Windows 版

在现有架构基础上新增的 **Windows 客户端**。**不修改任何现有源代码**：`native/`（macOS 版）与 `app/`（配置与数据）保持原样，本目录是纯增量。

## 与 macOS 版的关系

macOS 版是 SwiftUI + PDFKit 原生应用（9600+ 行 Swift）。SwiftUI / PDFKit **在 Windows 上不存在**，所以 Windows 版不是"重新编译"，而是**新写一个客户端 + 移植可复用的纯逻辑**：

| 层 | macOS 版 | Windows 版 | 复用程度 |
|---|---|---|---|
| UI（约 7000 行） | SwiftUI 视图 | TypeScript + HTML/CSS | 重写 |
| PDF 渲染 | PDFKit | 系统关联阅读器打开 | 重写 |
| 纯逻辑（约 2600 行） | Swift | TypeScript | **逐条移植** |
| 本地数据 | `queue.json` / `papers/` / `library/` / `app/data/*.json` | **完全相同的文件与格式** | 共用 |

关键点：**两版读写同一份本地数据**。用 Windows 版打开同一个项目根目录，读到的就是 macOS 版写的笔记、状态、全文缓存。不需要迁移脚本，也不需要账号或云同步。

## 怎么跑

需要 Node.js 18+（开发时用的是 Node 23）。

```bash
cd windows
npm install
npm start          # 构建并启动
npm test           # 移植保真度回归（58 项）
npm run dist:win   # 打 Windows 安装包（NSIS + 免安装版）
```

工作区根目录的解析顺序（与 macOS 版同一机制）：

1. 环境变量 `CBCT_ROOT`
2. 从可执行文件所在目录向上最多 8 层，找含 `queue.json` 的目录
3. 当前工作目录

也可以从菜单「文件 → 切换工作区…」直接选包含 `queue.json` 的目录。

## 本版实现范围

**第一版（核心工作台）**：

- **今日论文** —— arXiv / PubMed 抓取、单源故障降级、首见日期追踪、今日新增计数
- **论文库** —— 搜索、状态切换、收藏、笔记自动保存（500ms 防抖）、系统标签
- **精读室** —— 原文（按页渲染）+ 精读笔记 + AI 助教（流式、范围切换、Page N 跳转高亮）
- **设置** —— API 地址 / 模型 / Key（Key 只写本地文件，不回显）
- **导入 PDF** —— 复制到 `library/`

**第二版（补齐可移植模块）**：

- **对比** —— 2–8 篇横向对比、**固定列**（提到最前，再点取消）、跨协议可比性警示、BibTeX / RIS 导出
- **趋势 / Research Gap** —— 系统标签聚合、时间窗口 + 样本数 + 证据集合三要素、样本不足拒下判断、红线措辞自检
- **研究想法** —— 问题/观察/假设/方法/验证实验、五种状态、证据带来源类型
- **结果表校验** —— 表结构校验（含**列序位置校验**）、单位证据、解读与表/图绑定
- **系统标签** —— 八类派生、命中依据词、覆盖报告（哪类无证据如实显示）
- **复现准备** —— 从论文库进入；五组分析校验、分析指纹、按版本隔离的核对清单、仓库依赖提示（`repoChecks` 规则扫描）
- **结果分析** —— 校验入口（含**列序位置校验**）、两方法差值计算（分母 0 / NaN / 溢出都拒绝）

### 校验现在真正接入了界面

第一版做完时，`idea.ts` / `reproduction.ts` / `result.ts` 三个模块**只有测试引用，界面没有任何入口调用它们**——也就是「校验逻辑写好了，但用户实际点得到的路径不受保护」。这一轮把它们全部接到写入边界：

| 入口 | 校验 |
|---|---|
| 想法页「保存为想法」+ 证据表单 | `validateIdeaEvidence`（仅「论文原文」要求页码+逐字摘录） |
| `idea:importApplication` | `validateResearchApplication`（整条只有未知字段也拒绝） |
| 复现页「校验并保存」 | `validateReproductionAnalysis`（1–4 项/组、页码须真实存在） |
| `results:analyze` / `results:save` | `validateResults` + `validateBindings`（含列置换拒绝） |
| `results:difference` | 分母 0、NaN、溢出都返回 null 而非编造数字 |

## 刻意保留的硬约束

移植时**没有**放宽任何校验规则，因为这些是产品可信度的一部分，不是实现细节：

- AI 回答必须引用真实存在的页码，否则拒绝保存（`validateEvidence`）
- 实验抽取的每条事实必须有页码 + 该页逐字摘录；字段里的数字必须被摘录支持
- 材料超限时**如实披露**只取了 N/M 页，并禁止据此断言"论文没有该内容"
- `References` 对任何检索范围都强制排除（否则方法/实验范围会把参考文献整段吸进证据）
- 方法名中间的数字不算测量值（`IntraTomo3D` 的 `3` 不能被当作证据），但 `RTX3090`、`1.2GB` 这类型号数字保留
- 流式中断的回答**不保存**——半个回答比没有回答更危险
- 损坏的 JSON **不静默回退**默认值（否则下次保存会覆盖用户数据）
- 结果表的单元格不仅要比对数字集合，还要**按表头列顺序**逐字出现——否则列置换能整体通过校验
- 趋势样本数 < 5 时只报计数，**不下趋势判断**；缺口表述固定为「检索范围内未见」，不构成「首次」声明
- 可比性警示只在「两个以上不同的**已知**值」时触发；未知值不参与判断，避免误报
- 分析类建议每条都必须带原文依据；只有未知字段（没有一条带页码）会被拒绝

## 目录结构

```
windows/
├── src/
│   ├── core/          纯逻辑（无 Electron 依赖，可单独测试）
│   │   ├── types.ts           数据模型（与 Swift 结构逐字段对应）
│   │   ├── evidence.ts        evidence-first 校验链 ★ 核心
│   │   ├── markdown.ts        Markdown 块级解析
│   │   ├── markdownTable.ts   GFM 管道表格解析
│   │   ├── typography.ts      排版尺度（与 Typography.swift 同值）
│   │   ├── paper.ts           论文身份/去重/推荐排序
│   │   └── store.ts           路径解析与原子写入
│   ├── main/          Electron 主进程
│   │   ├── main.ts      窗口 + IPC 白名单
│   │   ├── preload.ts   contextBridge（渲染进程无 Node/fs）
│   │   ├── ai.ts        OpenAI 兼容流式请求
│   │   └── discovery.ts arXiv / PubMed 抓取
│   ├── renderer/      渲染进程
│   │   ├── app.ts       视图与交互
│   │   ├── index.html
│   │   └── style.css
│   └── tests/
│       └── parity.test.ts   移植保真度回归
└── scripts/copy-static.js
```

## 安全基线

- `contextIsolation: true`、`nodeIntegration: false`，渲染进程只能通过 preload 暴露的 IPC 白名单访问能力
- CSP 限制 `default-src 'none'`，`connect-src 'none'`（渲染进程不发网络请求，抓取与 AI 都在主进程）
- Markdown 渲染**不支持原始 HTML**，全部转义后再插入
- 外链只放行 `http/https`，防止被诱导打开本地可执行文件
- API Key 不回传渲染进程

## 验证状态

本机（Apple Silicon macOS）实际验证过的：

| 项 | 结果 |
|---|---|
| `npm run build` | 通过（core / main / renderer 三份产物） |
| `npm test` | **193 项通过，0 失败**（12 个测试文件） |
| 应用实际启动（Electron，无 `RUN_AS_NODE`） | 窗口打开、4 个导航页可用、0 页面错误 |
| 真实数据贯通 | 论文库 5 篇；NAF 打开后原文 26,041 字符、6 个笔记段落、11 个页码锚点 |
| 新增视图实机走查 | 6 个导航页全部可用；趋势 21 条发现、系统标签覆盖 8 类 / 29 个标签、引用导出 BibTeX+RIS 均产出内容、0 页面错误 |
| `Page N` 证据跳转 | 点击后滚动到对应页并高亮 |
| 只读路径不改数据 | 断言过：跑完全部只读 IPC 后用户数据哈希不变 |
| `electron-builder --win` | **产出真实 `CBCT每日精读.exe`**（PE32+ executable, Aarch64, 176 MB） |
| macOS 版回归 | `native/test.sh` 仍 **109 通过 / 0 失败** |

**没有验证的**：Windows 真机运行。产物是真实 Windows 可执行文件（`file` 已确认 PE32+ for MS Windows），但本机是 macOS，无法运行它，因此**双击安装、字体渲染、DPI 缩放、系统阅读器打开 PDF 这些行为未经实机确认**。

## 已知差异与限制

诚实列出，避免误以为与 macOS 版功能对齐：

1. **LaTeX 公式不做排版**：macOS 版有自研 LaTeX 排版引擎（`MathTypeset.swift`，565 行）。Windows 版按源码转义展示并标注需核对原 PDF，**没有**行内公式排版。
2. **PDF 用系统阅读器打开**：没有内置 PDF 面板，因此**不能**像 macOS 版那样在应用内点 `Page N` 在 PDF 上高亮。Windows 版的 `Page N` 跳转是在左侧**全文文本面板**内滚动定位。
3. **OCR 未实现**：扫描版 PDF 的 Vision OCR 依赖 macOS Vision 框架。Windows 版只读 `library/text/` 里已有的缓存；缓存由 macOS 版生成后可直接共用。OCR 来源的缓存会在界面顶部明确警示。
4. **向量检索未移植**：Chat 的跨论文扩展（`/embeddings` + 本地向量索引）未实现，本版只有单篇问答。
5. **未移植的模块**：复现难度分析、论文↔代码映射、Idea 笔记本、基线库、系统标签、趋势分析、方法公式工作流、迁移建议。
6. **表格列宽均分**：按列数平分并夹在 96–320px，未按内容自适应。
7. **未设置应用图标**：打包时用 Electron 默认图标。

## 移植过程中修掉的缺陷

都是「能跑但结果是错的」这一类，全部有回归测试 + 变异验证（故意改回错误实现，确认测试会失败）：

1. **节流写盘丢编辑**：`ThrottledWriter` 原实现在窗口结束时直接丢弃 pending，用户在去抖窗口内的最后一次输入永不落盘（重启后内容消失）。
2. **删除被回滚**：论文库状态每次改动都「重读磁盘 → 生成快照 → 节流写」。在打字窗口内「移入回收站」，窗口结束时落下的旧快照会让删除失效——论文约 600ms 后复活。改为所有写入共享一份内存权威状态。
3. **笔记段落静默丢失**：真实笔记标题带编号（`## 1. 问题设定`），而匹配用的是精确相等，导致除「一句话总结」外 5 个段落全部为空。
4. **标题首字被吃掉**：去编号正则把分隔符写成可选，`一句话总结` 变成 `句话总结`、`3D 重建` 变成 `D 重建`。
5. **页码锚点全部失效**：锚点查询 `h2`，但标题实际渲染成 `.md-h` 的 `div`；且标题里的 `Page N` 已被链接化，`id` 永远设不上，导致点证据链接无法跳转。
6. **证据链接破坏 HTML 结构**：在已生成的 HTML 字符串上跑 `Page N` 正则，会改写 `href` 属性内容，产出嵌套 `<a>` / 破损标签。改为「先转义、再以占位符插入链接」。
7. **有笔记的论文完全不可见**：只读 `queue.json`，导致唯一有全文缓存与笔记的 NAF（不在队列里）在 Windows 版看不到。现已合并 `papers/*.md`，与 macOS 版权重一致（笔记优先）。
8. **对比页字段读错来源**：把 `views` / `geometry` / `datasets` 当成库状态字段读，但这些字段实际在笔记 frontmatter 里。后果不只是显示「尚未抽取」——跨协议可比性警示**永远不会触发**（没有可比较的已知值，等于这条安全提示失效）。已改为「笔记 frontmatter → 已抽取实验字段 → 如实标未知」。
9. **`validateConfiguration` 缺失**：该函数由 macOS 侧在本移植期间新增（`ResearchModels.swift` 377→392 行），我最初读到的版本里没有。已补上并加回归测试。
10. **丢失了 Swift 解码期的结构保证**：Swift 的 `JSONDecoder` 解码非可选数组字段时，缺字段会以 `keyNotFound` 失败；`JSON.parse` 只把它变成 `undefined`。后果是模型少给一组时，校验崩溃成 `Cannot read properties of undefined (reading 'length')` / `a.statistics is not iterable` 这类 **TypeError**，而不是可读的校验消息。三个 decoder（results / idea / reproduction）都补回了结构检查。这是"移植时只搬了函数体、没搬类型系统提供的保证"的典型案例。
11. **三个模块写了但没接入界面**（678 行）：`idea.ts` / `reproduction.ts` / `result.ts` 只被测试引用，界面无入口，导致"校验只在测试里活着"。已全部接到写入边界，并补上想法页证据表单与复现页。

## 测试

`npm test` 跑的是**移植保真度回归**：把 macOS 版 `native/Tests/CBCTReadingTests/` 的断言逐条翻成 TS。任何一条失败都说明移植改变了语义，而不是"测试太严"。

覆盖：表格解析（含真实产物 `NAF-chat-geometry.md` 的 6×5 表格逐字核对）、水平分隔线、小数不误判为有序列表、页码解析与引用校验、摘录/数字支持校验、范围披露、章节范围与 References 排除、论文去重与排序、真实 `queue.json` 与 NAF 全文缓存的读取。

macOS 版自身的测试不受影响，仍然运行：

```bash
native/test.sh
```


## 关于「移植期间上游被并发修改」

本移植进行期间，`native/` 下的 macOS 源码**被另一个写入者同时编辑**（不是本移植所为，本移植的写入只发生在 `windows/` 与 `/tmp/`）。实测证据：

- 会话开始时 `git status` 列出 20 个已修改文件；会话结束时多出 `MarkdownTableView.swift`，且 `ResultTablePoster.swift`、`MathTypeset.swift` 在 00:09 / 00:27 被改动。
- `ResearchModels.swift` 从我读取时的 **377 行**变成 **392 行**，新增了 `ExperimentExtraction.validateConfiguration()`——这正是上面第 9 条缺陷的来源。
- `papers/2022-naf.md` 在 00:37 被追加了一行批注（macOS 应用仍在运行，会写入这份笔记）。这反而成了一次真实测试：本移植的笔记解析器读到了新增内容（annotations 段落 124→154 字符），且 6 个段落仍全部解析正确。

因此以下两类**必须**以当前工作区状态为准重新核对，不能只信「移植当时读到的版本」：

1. **常量表**：已用脚本逐项比对当前 Swift 与 TS，结果一致——`forbiddenPhrases` 6/6、`negationMarkers` 11/11、SystemTag 词表 43/43、`dependencyFileNames` 10/10。
2. **函数体**：逐个核对移植来源文件的当前内容；发现并补上了 `validateConfiguration`，其余未变。

**给后续维护者的提醒**：上游仍在变动时，任何「与 macOS 版一致」的结论都有时效。修改任一侧的校验规则后，请重跑 `npm test`，并重新比对相应常量表。

## 上游已存在、本移植保真保留的弱点

用**真实 Swift 代码**（`swift` 直接跑复刻实现）逐例比对过，以下是 macOS 原版的行为，移植**刻意不做「顺手修好」**，否则两平台判定会不一致：

- `violatesRedline("no claim of being first to do this")` → `true`。否定标记 `no claim of` 距离禁用语 `first to` 超过 12 字符窗口，未被识别为否定语境。
- `violatesRedline("not the first「首次」")` → `true`。`negationMarkers` 里存的是整串字面量 `"not the first"`，中间插入引号后无法匹配。
- `violatesRedline("不是这回事，但这是首次提出")` → `false`。`不是` 落在 `首次` 前 12 字符内，整句被当作否定语境放行——尽管 `不是` 否定的是别的事。

这些是**放宽判定**或**误判**方向上的弱点（前者可能漏拦「首次」声明，后者可能误放）。建议在 macOS 侧统一修复后再同步到本版；在修复之前，两版行为一致。
