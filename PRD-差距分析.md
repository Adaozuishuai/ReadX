# PRD 差距分析：项目还差哪些功能

对照文档：`CBCT每日论文精读软件_产品需求文档_PRD.pdf`（V1.0，20 页，794 KB）
分析日期：2026-10-02 ｜ 方法：PDFKit 抽取全文 + 逐项 grep 核对源码，**不采信 README/PRD-路线 的自述**
代码基线：`native/Sources/CBCTReading/` 27 个 Swift 文件 / 4805 行；`app/` 兜底版；`native/test.sh` 40 passed

---

## 0. 先说结论

**P0（MVP 必须）已经基本齐了** —— 9 个模块全部有实现，这是和文档 `PRD-验收矩阵.md` 自述最大的不同：那个矩阵把不少「已实现」标成「部分/待实现」，偏保守。

**真正的缺口集中在 P1 与 P2**，而且有三处是**文档明确点名、代码里连数据模型都没有**的：

| 缺口 | 性质 |
|---|---|
| **Baseline 百科与方法卡片**（4.7） | 代码中零实现，连结构体都没有 |
| **向量检索 / Metadata Index**（6.1、6.2、7.1） | 全仓库无 `embedding`/`vector`/`cosine`；检索是关键词启发式 |
| **引用导出**（4.13、8.3） | 无 BibTeX/引用格式导出；仅有 Markdown/CSV/JSON |
| **Trends / Research Gap**（4.16、3.1） | "知识地图"页面存在，但只做主题聚合，没有时间窗/证据集合 |
| **通知设置**（3.1） | 无面向用户的通知；7 处 `notification` 全是 `NotificationCenter` 内部事件 |

另有三处**结构性缺口**（不是某个功能没写，而是地基缺失）：**账号与跨设备同步**、**通知设置**、**领域标签体系（7.2）**。

---

## 1. 逐条对照 PRD

### 1.1 P0 — MVP 必须（9.1）

| PRD 模块 | 代码实现 | 状态 |
|---|---|---|
| 账号 / Profile：方向、主题、数据集、硬件偏好 | `ProfileWorkspace` + `ResearchProfile`（topics 权重、datasets、methods、metrics、hardware、task） | **有**，缺账号 |
| Daily Papers：arXiv + PubMed、去重、主题过滤、推荐卡 | `DiscoveryService.arxiv/pubmed`、`PaperIdentity.same`（DOI/arXiv/标题+作者）、`FunDashboard` PaperCard | **有** |
| Paper Detail：PDF 阅读、TL;DR、5 分钟精读 | `PDFKitView`、`openReading(kind:"tldr"/"deep")` | **有** |
| Method：网络/流程文字解析、关键公式解释 | `case "method"` + 专用 prompt（数据流/模块/几何/公式） | **有**（文字级，非结构化图） |
| Experiment：Dataset/Training/Metrics/Main Results 抽取 | `ExperimentExtraction` 7 类字段 + 摘录/页码/数字校验 | **有**，最扎实的一块 |
| Paper Chat：单论文 RAG + 原文引用 | `runAsk` + `Evidence.select` + 引用页码白名单 | **有** |
| Library：收藏、已读、稍后读、标签、笔记 | `LibraryWorkspace` + `LibraryState` | **有**，无删除/恢复 |
| Feedback：相关/不相关、AI 纠错 | `relevance`（-1/0/1）+ `corrections`，负反馈进 `negativeTopics` 影响排序 | **有** |

**P0 结论：8/8 有实现。** 差距只在「横切能力」（账号、通知、引用导出），不在功能模块。

### 1.2 P1 — V1 核心增强（9.2）

| PRD 模块 | 状态 | 说明 |
|---|---|---|
| Compare 多论文对比（2–8 篇） | **有**（缺细节） | 有矩阵/维度切换/Markdown/CSV；**缺「可固定列」**（5.3 明确要求）与保存 |
| Baseline 百科与方法卡片（4.7） | **完全缺失** | PRD 点名 FDK/SART/DuDoNet/C²RV/NeRP/Trans²-CBCT；全仓库无 `BaselineCard` |
| Results Analysis（4.6） | **有** | 主表抽取、程序计算差值、作者统计措辞、稳定性/消融/泛化/效率 |
| Critical Review（4.11） | **有** | 五节结构 + `case "critical"` |
| Paper ↔ Code Mapping（4.9） | **有** | GitHub 固定 commit、文件/行证据、confidence、人工核对转「明确映射」 |
| Reproduction Analysis（4.10） | **有**（论文材料阶段） | 五维 + 版本化核对清单；**未扫描实际仓库/依赖/训练** |
| Idea Notebook（4.14） | **有** | 七字段 + 五状态 + 证据来源区分 |
| Apply to My Research（4.15） | **有** | 四类建议 + 画像快照过期提示 |

**P1 缺口：Baseline 卡片（0%）、Compare 固定列（0%）。**

### 1.3 P2 — 后续增值（9.3）

| PRD 模块 | 状态 |
|---|---|
| Research Gap / Trend（4.16） | **部分**：`TopicMapWorkspace` 做主题计数与跳转；**无时间窗口、无样本数、无证据集合**（PRD 12 风险表明确要求这三样） |
| Citation Evolution / 研究图谱（7.3） | **缺失**：无 cites/extends/compares_with 关系 |
| 团队共享知识库 | **缺失** |
| 自动 Related Work 草稿（13） | **缺失** |
| 实验追踪 / Compare Board | **缺失** |
| GitHub / Overleaf / Notion 集成 | **缺失** |
| Benchmark Hub（13） | **缺失** |
| CBCT Geometry Sandbox（13） | **缺失** |

---

## 2. 需求点了名、代码里没有的东西（按「差得最彻底」排序）

> **注意**：本节记录的是「补齐前」的状态。文末「补齐进度」列出本轮已完成项；两处冲突时以文末为准。

### 2.1 Baseline 百科与方法卡片 —— 原为「完全没开始」→ ✅ 本轮已实现（见文末补齐进度）

PRD 4.7 要求为 **FDK、SART、DuDoNet、C²RV、NeRP、Trans²-CBCT** 建方法卡片，字段：论文来源、任务、输入输出、核心思想、代码、常用数据集、适用设置、**与当前论文关系**。

代码里 `grep -rni "baseline card|BaselineCard|methodCard"` **零命中**。当前 `baselines` 只是实验抽取里的一个字段数组（`ExperimentExtraction.baselines`），是「某篇论文提到了哪些基线」，不是「基线本身的知识条目」。

这是**跨论文知识沉淀**的核心，也是 Compare 能真正做「方法差异」而不是「字段并排」的前提。

### 2.2 向量检索 + Metadata Index —— 没有地基

PRD 6.1 pipeline 明确有 `Vector + Metadata Index`，6.2 要 `PaperSection.embedding`，7.1 实体表里 `PaperSection` 带 `embedding` 字段。

代码：`grep -rni "embedding|vector|cosine"` **零命中**。当前检索是 `Evidence.select` 的关键词打分（`terms.reduce(0) { $0 + (page.text.lowercased().contains($1) ? 1 : 0) }`）——**按页计数排序的启发式**。

后果：Chat 的「先检索当前论文，再扩展到用户 Library」（6.3）**做不到**，因为 Library 没有可检索的向量索引；跨论文语义检索缺失。

### 2.3 引用导出 —— 小功能，但 PRD 写了两次 → ✅ 本轮已实现

PRD 4.13「引用导出」、8.3「支持导出与删除个人 Library / Notes / Ideas」。

代码有：Markdown（Ideas/复现清单）、CSV（Compare）、JSON（研究资产 schema 1.4）。
**没有**：BibTeX / RIS / 任何标准引用格式。

### 2.4 Trends 的证据契约 —— 有页面，无契约 → ✅ 本轮已实现

PRD 4.16 与 12 风险表对趋势的要求是**三条硬约束**：
- 展示**时间窗口**
- 展示**论文数量 / 样本数**
- 展示**证据集合**
- 且「只能输出证据支持的潜在空白，不能包装成首次」

`TopicMapWorkspace` 目前是主题标签 + 论文计数 + 点击筛选。**时间窗、样本数口径、证据集合三项都没有**。按 PRD 的说法，缺这三样的"趋势"属于**风险表中的「趋势误判：样本少导致伪趋势」**，即当前实现本就落在它自己警告的坑里。

### 2.5 账号 / 跨设备同步 / 通知 —— 三条地基缺口

- PRD 3.1 顶层导航里 Profile 的职责包含**通知设置**；4.1 待读队列要求**状态跨设备同步**。
- 代码：`account` / `login` / `sync` / `cloud` **零命中**；`notification` 有 7 处命中，但**全部是 `NotificationCenter` 应用内事件**（PDF 选区变化、页面变化、退出钩子，见 `NativeViews.swift:29/224/231`、`App.swift:20`），**没有面向用户的通知/提醒设置**。
- 现状是纯本地 JSON（`app/data/*.json`）。这与 PRD「默认私有」一致，但**跨设备同步是明确需求且未实现**。

### 2.6 领域标签体系（7.2）→ ✅ 本轮已实现

PRD 要求系统标签覆盖 **Task / Domain / Acquisition / Architecture / Learning Paradigm / Dataset / Metric / Venue** 八类，与用户标签并存。

代码：只有用户自定义 `tags: [String]` + 一个 `TopicNavigation.matches`（主题匹配）。**没有系统标签体系**，因此「按 Task/Domain/Architecture 过滤」只能靠关键词。

### 2.7 RAG 与 multimodal 抽取（6.3）

PRD 6.3 明确：「结果表、公式和图像应采用**专门 parser / multimodal extraction**，而非只依赖纯文本切片」。

代码：`PDFLayout.rows` 做物理行表格恢复（有效，实测 NAF Table 2 全对），但**公式仍是纯文本**——`REPORT.md` 自己记录「Page 4 Eq.(1) 的 XOR 聚合运算符在文本抽取中缺失」，只能标「转写待核对」。图像理解完全没有。

---

## 3. 已实现但**未达验收标准**的部分

这些不是「没写」，是「写了但证据不足」（PRD 10.1/10.2）：

| 验收项 | 实际证据 | 差距 |
|---|---|---|
| AC-01 去重 | 有 DOI/arXiv/版本/标题+作者 | 缺**模糊标题**检索（自述已认） |
| AC-02 每条 Top Pick 至少 1 条画像理由 | `matchesProfile` 过滤，`reasons` 兜底为「领域探索」 | **注意**：兜底理由会让「画像匹配」口径变宽，需核对是否所有 Top Pick 都真有画像理由 |
| AC-03 精读完整性 | NAF 单样本五节齐全 | **单篇样本**，无多论文评测 |
| AC-04 引用定位 | 页码校验 + 跳页 + 高亮 | 无「≥90% 关键结论可定位」的统计 |
| AC-05 实验抽取 | 结构校验强（摘录/页码/数字） | 实测 25 通过 / 10 拒绝（71%）；`experiment` 仅 25% |
| AC-06 Chat Grounding | 引用白名单 + 未知兜底 | 无「≥90% 无幻觉」度量 |
| AC-07 Library 持久化 | 有回归测试 | 缺**删除/恢复**（8.3 要求） |
| AC-08 反馈闭环 | 有回归测试 | 达标 |
| 10.2 CBCT 专业性 | 有专门 prompt 约束（区分 sparse-view/low-mAs、FDK/SART 非网络、保留单位、simulation 不等于临床） | 单样本，无评测集 |

**最关键的未达标项**：`PRD 1.4` 的四项成功指标——**引用可追溯率 ≥90%、有效推荐 ≥70%、精读完成率 ≥40%、每周 ≥3 条资产**——**全部未测量**（`PRD-验收矩阵.md` 自述「未测量」，我核对确认无任何埋点代码）。

---

## 4. 与文档自述的偏差（值得注意）

项目里的 `PRD-验收矩阵.md` 把不少已实现项标成「部分/待实现」。核对后我认为**矩阵偏保守**，实际状态更好：

| 矩阵自述 | 实际代码 |
|---|---|
| 「七类实验配置…多论文设置/单位验收尚缺」标部分 | 实现完整，且有摘录/数字/单位三重校验 + 真实运行记录 |
| 「Critical Review…需多论文核对」标部分 | 已实现五节结构，NAF 样本通过 |
| 「Results 主表差值…」标待实现 | **已实现**：`ResultDifference.calculate` 程序算差值 + 对数尺度禁用相对百分比 |
| 「Paper↔Code 映射…」标待实现 | **已实现**：固定 commit、行证据、confidence、人工核对 |
| 「Idea Notebook」标部分 | 七字段 + 五状态 + 四类证据来源，完整 |

反过来，矩阵**漏报**了几个真实缺口：Baseline 卡片、引用导出、通知、账号同步。这几项在矩阵里没有独立行。

---

## 5. 建议的补齐顺序

按 PRD 11.1 的推荐顺序 + 当前实际缺口：

**第一优先（P1 收尾，投入小、价值直接）**
1. **Baseline 卡片**（4.7）—— 纯结构化录入 + 与 Compare 联动，不需要新依赖。PRD 点名 6 个方法，可先做这 6 个做样板。
2. **Compare 固定列**（5.3）—— 现有矩阵加列固定即可。
3. **引用导出**（4.13/8.3）—— BibTeX/RIS，从 `QueueEntry` 映射即可。

**第二优先（补地基）**
4. **系统标签体系**（7.2）—— 八类标签，是所有过滤/Trends/Compare 的前提。
5. **Trends 的证据契约**（4.16）—— 给现有 `TopicMapWorkspace` 补时间窗 + 样本数 + 证据集合三项，**这是 PRD 风险表直接警告的点**。

**第三优先（大工程，需先确认）**
6. **向量 + Metadata Index**（6.1/6.2/7.1）—— 决定 Chat 能否跨 Library 检索。
7. **账号 / 跨设备同步 / 通知**（3.1/4.1）—— 纯本地架构的扩展，需要先定同步冲突策略。
8. **multimodal 公式/图像抽取**（6.3）—— PRD 明确要求，但依赖视觉模型，成本最高。

**独立于功能之外**
9. **测量 PRD 1.4 的四项指标** —— 现在完全无埋点。不做这一步，任何「已达标」声明都缺依据。

---

## 附：核对方法与本轮新增文件

- PRD 全文用 PDFKit 抽取（20 页 / 15782 字符）后**逐页阅读**；第 17 页路线图表格在纯文本抽取中列序有错位（表格跨栏），已避开该页做判断，其余章节文本完整。
- 每项结论用 `grep` 在 `native/Sources/CBCTReading/` 实测，而非引用文档自述。
- **抓到一个自查错误**：初版我写「零 `notification`」，复核发现 7 处命中；逐条查看后确认全是 `NotificationCenter` 内部事件，结论不变但表述已改精确。为避免中文编码假阴性，所有「缺失」结论都做了**阳性对照**（确认 grep 能匹配中文，如「画像」命中 5 个文件）与**英文二次验证**。
- 本轮发现的代码演进：新增 `FunWorkspace.swift`(102)、`FunDashboard.swift`(173)、`FunTheme.swift`(87)，导航新增 `Topics`/`Map` 页与 `workspaceTopic`/`workspaceSearch` 状态；`WorkspaceViews.swift` 从 319 行重构为 223 行。这些在我此前的 Code Review 之后加入，**尚未纳入缺陷审查**（如需，可另开一轮）。

---

# 补齐进度（2026-10-02 本轮）

按本文档第 5 节的建议顺序，已完成前 5 项。**全部按最小修改原则新增独立文件**，
未改动任何既有 prompt、校验阈值、数据划分或网络结构。

验证基线：`native/test.sh` **73 passed / 0 failed**（本轮开始前 40），`swift build -c release` 通过，
`native/js-test.sh` 20 项全过。

| # | 缺口 | 状态 | 新增文件 | 回归 | 变异测试 |
|---|---|---|---|---|---|
| 1 | 引用导出 BibTeX/RIS（4.13/8.3） | ✅ 已实现 | `CitationExport.swift`、`CitationStore.swift` | 8 条 | 2 次（esc 失效、RIS 缺 ER）均 FAIL |
| 2 | Compare 可固定列（5.3） | ✅ 已实现 | `CompareModels.swift` | 4 条 | 2 次（不排序、不清理失效固定）均 FAIL |
| 3 | 系统标签八类（7.2） | ✅ 已实现 | `SystemTags.swift`、`SystemTagStore.swift` | 7 条 | 2 次（不做匹配、coverage 恒 0）均 FAIL |
| 4 | Trends 证据契约（4.16） | ✅ 已实现 | `TrendAnalysis.swift` | 7 条 | 3 次（降样本下限、去掉时间窗、redline 恒 false）均 FAIL |
| 5 | Baseline 方法卡片（4.7） | ✅ 已实现 | `BaselineLibrary.swift` | 7 条 | 2 次（FDK 标成网络、别名全匹配）均 FAIL |

## 各项实现要点

**1. 引用导出**：`@misc`（arXiv）/`@article` 自动选择；BibTeX 特殊字符转义（`& % $ # _ { } ~ ^`）；
作者「First Last」→「Last, First」；引用键回退顺序 arXiv→id→标题；字段为空则整行不输出。
UI：论文库每篇卡片加「引用」菜单（复制 BibTeX / 导出 BibTeX / 导出 RIS），列表顶部可导出当前筛选结果。

**2. Compare 固定列**：固定列提到最前，其余保持相对顺序；再点一次取消；选择集变化时清理失效固定。
**导出与屏幕列序保持一致**（`orderedSelected` 同时供表头、表体、CSV/Markdown 使用）。

**3. 系统标签**：八类（Task/Domain/Acquisition/Architecture/Learning Paradigm/Dataset/Metric/Venue）；
每条标签带**命中依据词**供核对；命不中就不输出（不推测）；与用户自建标签**并存不覆盖**；
UI 明确列出**未涉及的类别**，而不是假装八类都有。

**4. Trends 证据契约**：时间窗口 + 样本数 + 证据集合**三样强制同时展示**（`disclosure`）；
**样本 <5 篇拒绝下趋势判断**，只报告计数——这正是 PRD 第 12 节风险表点名的「样本少导致伪趋势」；
Research Gap 只能表述为「检索范围内未发现」，并附「不等于无人研究、不构成首次声明」；
额外加了**红线措辞自检**（首次/首个/no one has…）。

**5. Baseline 卡片**：PRD 点名的 6 个方法（FDK/SART/DuDoNet/C²RV/NeRP/Trans²-CBCT）全部覆盖，
另加项目已用的 IntraTomo3D。按 PRD 10.2 要求，**FDK/SART/ASD-POCS 标为解析/迭代方法而非神经网络**。
字段来源分「领域常识」与「待核对」，不确定的一律留 `nil`，**不编造代码链接**。
与「某篇论文提到哪些基线」严格区分：后者用 `ExperimentExtraction.baselines`，
卡片只用来说明「该论文是否提到该方法」，**不做优劣推断**。

## 仍未完成（按优先级）

| # | 缺口 | 原因 |
|---|---|---|
| 6 | 向量 + Metadata Index（6.1/6.2/7.1） | 需引入嵌入模型与索引存储，属架构级改动 |
| 7 | 账号 / 跨设备同步 / 通知（3.1/4.1） | 纯本地架构扩展，需先定同步与冲突策略 |
| 8 | multimodal 公式/图像抽取（6.3） | 依赖视觉模型，成本最高 |
| 9 | 测量 PRD 1.4 四项指标 | 需埋点设计；不做则任何「已达标」缺依据 |

另有本文档早前列出的 P2 项（Citation Evolution、团队知识库、Related Work 草稿、Benchmark Hub、
Geometry Sandbox、外部集成）仍未开始。

## 一处需要你注意

本轮 5 项都做了**变异测试**（故意把修复改坏，确认测试会 FAIL），累计 11 次变异全部被捕获。
但 **UI 层只做了编译验证，没有 GUI 走查**——引用菜单、固定列按钮、系统标签区、趋势区、
基线卡片这五处界面需要你运行 `native/build-app.sh` 后目视确认。
