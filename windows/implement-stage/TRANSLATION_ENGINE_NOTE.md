# Lee 翻译引擎实现说明

> 当前双端入口：Windows 与 macOS 的受管核心源码已统一运行下述 provider-case 主链。旧段落中关于 macOS 独立 Go 翻译入口、未接入 OCR 或尚未提供渲染目录的描述属于历史记录，不能作为当前架构依据。当前目录和平台边界见 `../../docs/architecture.md` 与 `../../macos/README.md`。

上游来源：[RetainPDF](https://github.com/wxyhgk/retain-pdf)。ReadX 将其翻译能力内置并集成为 Lee 引擎。

Windows 版由 ReadX 提供上传入口和文库，实际 PDF 处理通过随仓库内置的 Lee Python `provider-case` 全流程执行：PaddleOCR、`document.v1` 归一化、Lee 翻译/修复、Lee RPR 排版。无需启动第三方桌面端或其 API/任务服务；OCR 与模型凭据由 ReadX 后端从本机设置注入子进程环境，Codex CLI 通过仅监听回环地址的临时 OpenAI 兼容桥接供 Lee 调用。Lee 输出的标准化版面、逐段译文和译文 PDF 再保存到 ReadX 文库。

## 内置了什么、重写了什么

上游 RetainPDF 由几块组成：Rust API + Python 翻译流水线（约 4 万行，依赖它自己的
`document.v1.json` 协议）、PaddleOCR/MinerU 远程 OCR、以及一个独立的 Node.js 排版
引擎（retain-pdf-rendering）。

- **排版渲染**原样内置：引擎是 Node，ReadX 的 Electron 自带 Node，直接把
  `resources/rendering-engine` 作为子进程运行。
- **OCR、归一化、翻译、修复和导入排版**由随 ReadX vendor 的 Lee `provider-case`
  pipeline 实际执行；ReadX 只把 `document.v1` 与逐页 translation payload 投影到自己的
  文库数据结构。模型 API 配置直接传给 Lee；Codex CLI 通过随机令牌保护的回环桥接调用。
- **阅读器显示**直接加载 Lee 生成的整本译文 PDF（`/translated-pdf`），不再按页重排；
  原文的「段落识别」使用 Lee `document.v1` 的块与阅读顺序，不再用 PDF.js 重新切段。
- **题录识别**仍由 ReadX 负责：Lee 不返回题名/作者/期刊，导入完成后用 OCR 首页文本
  调用一次模型识别题录（失败只记日志，不阻断已完成的翻译）。

## 翻译与排版的边界

Windows PDF 导入执行 Lee Python provider pipeline。PaddleOCR 仍是用户设置的
远程 OCR 服务；排版通过 Lee 的 RPR 引擎完成。ReadX 桌面应用不启动第三方
桌面端、Rust API 或独立任务服务。

| 能力 | ReadX 文件 | 对应 RetainPDF |
| --- | --- | --- |
| 占位符与术语保护（代码/链接/邮箱、preserve/canonical；术语 exact/case_insensitive/regex 与局部上下文匹配） | `apps/server/internal/translate/protect.go`、`terms.go`、`db/migrations/0006_glossary_match_modes.sql` | `core/payload/token_protection.py`、`inline_protection.py`、`core/payload/term_protection.py`、`core/terms/glossary.py` |
| 系统/任务/重译提示词、默认科研规则档、标题与结构化技术块规则 | `apps/server/internal/translate/prompt.go` | `prompts/translation_system.txt`、`translation_task.txt`、`translation_zh_conventions.txt`、`prompts/rule_profile_general_sci.txt`、`services/policy/title_rules.py`、`structured_technical_blocks.py` |
| 确定性质检 | `apps/server/internal/translate/review.go` | `llm/validation/quality.py`、`english_residue.py`、`services/quality/qa/numerics.py` |
| 分批、并发、修复 | `apps/server/internal/translate/engine.go` | `workflow/batch_runner.py`、`workflow/phases/repair.py` |
| OCR 乱码重建 | `apps/server/internal/translate/garbled_reconstruction.go`、`../macos/apps/server/internal/translate/garbled_reconstruction.go` | `services/postprocess/garbled_reconstruction.py`、`workflow/phases/repair.py` |
| 默认数学直通 | `apps/server/internal/translate/protect.go`、`prompt.go`、`review.go`、`../render/math_check.go` | `math_mode=direct_typst`、`translation_direct_typst_guidance.txt`、`direct_typst.py`、`render_check.py` |
| 原文快速保留策略 | `apps/server/internal/httpapi/translated_pdf.go` | `services/fast_path/keep_origin.py`、`services/policy/verdict.py`、`special_blocks.py` |
| macOS 翻译入口 | `../macos/apps/server/internal/ai/translate.go` + `../macos/apps/server/internal/translate/`（同源引擎副本） | 同一套单段请求、质检、Agent 修复与最终恢复 |
| Windows 导入全文处理 | `apps/server/internal/httpapi/lee_import.go`、`publications.go` | `provider-case`：Paddle OCR、document.v1、translation、repair、RPR render |
| macOS 导入翻译入口 | `../macos/apps/server/internal/httpapi/import_translation.go` | OCR 段落筛选、翻译、缓存与续接处理 |
| macOS 阅读器 OCR 译文 | `../macos/apps/server/internal/httpapi/ocr_layout.go`、`../macos/apps/web/src/components/ReaderScreen.tsx` | 按页读取已存 OCR 坐标与块级译文，在原 PDF 上叠加 |
| macOS 译文 PDF 导出 | `../macos/apps/server/internal/render/render.go`、`../macos/apps/server/internal/httpapi/translated_pdf.go`、`../macos/apps/web/src/components/ExportPDFDialog.tsx` | 复用 RPR 输入协议；用导入时 OCR 版面及段落译文，不把段落数当页数 |
| 译文 PDF 排版引擎 | `resources/rendering-engine`（上游固定提交） + `scripts/render-translated-pdf.cjs` | `backend/rendering-engine`、`render/output/rpr` |
| 译文 PDF 接口 | `apps/server/internal/render/render.go`、`httpapi/translated_pdf.go` | `render.stage.v1` 与 rpr 合并 |
| 阅读器段落识别 | `apps/server/internal/httpapi/translated_page.go`（`handleDocumentParagraphs`）、`apps/web/src/components/ReaderScreen.tsx` | `document.v1` 归一化后的块与阅读顺序，不再用 PDF.js 重新切段 |
| 扫描件 OCR | `apps/server/internal/ocr/paddle.go`、`httpapi/ocr_settings.go`、`../macos/apps/server/internal/ocr/paddle.go` | `ocr_provider/paddle_api.py` 与 Paddle 适配 |
| 导出界面 | `apps/web/src/components/ExportPDFDialog.tsx` | 桌面端导出译文 PDF |

## 译文 PDF 的处理顺序

1. 服务端把整份 PDF 交给 PaddleOCR，按 `parsing_res_list` 的块类型与坐标筛出可译块；
   页眉、页脚、页码、作者/单位、邮箱、URL、参考文献、独立编号、协议十六进制转储及识别为贡献者名单的长列表保留原样。
2. 按上游 document.v1 的块类型与翻译策略挑块，相邻块/跨页块注入消歧上下文，逐段翻译。
3. 把每页块转成 `rpr_retain_input_v1` 的 `box_overlay` 块：`content_box` 与原块一致，
   `cover_box` 用同框白色覆盖原文，字号上限取原文实际字号。
4. 内置 rpr 引擎（Node，Electron 自带运行时）产出每页透明 `overlay.pdf`。
5. `scripts/render-translated-pdf.cjs` 用 pdf-lib 把叠加层按页叠回原 PDF，保留
   原目录、页尺寸和图表/公式/表格的原始像素。

## 导入时的翻译链（唯一路径）

**必须同时配置 PaddleOCR 与 AI 助教**；缺任何一个，PDF 导入直接失败，不再有文本层
分段或旧翻译接口作为回退。

1. ReadX 上传/链接导入入口把 PDF 写入 Lee job workspace，并生成 `provider.stage.v1` spec；
2. Lee Paddle provider 产出原始 OCR 与 `document.v1`；
3. Lee 翻译链按其原生策略执行筛选、续接、批翻译、缓存、质检与修复；
4. Lee RPR 引擎生成整本译文 PDF；
5. ReadX 将 Lee 标准化段落与对应译文写入自己的页面/翻译表及版面状态，然后把 Lee PDF 保存为文库译文文件；
6. Codex CLI 模式下，Lee 调用随机端口、仅监听 `127.0.0.1` 的短生命周期兼容桥；API 凭据只通过子进程环境传递，不写入 stage spec。

## 阅读器里的「OCR 排版译文」

工具栏按钮走 `POST /v1/documents/{key}/pages/{page}/translated-page`，与导出口径一致，
但只产出当前页；导入时已带 `ocr-layout` 的文档，阅读器会自动按页渲染，无需点按钮。
没有版式数据的旧文档才用按钮按需 OCR（同样要求已配置 PaddleOCR 与 AI，结果缓存）。

1. OCR 原始结果按「原 PDF 内容哈希」缓存在本机（`app/data/v2/cache/ocr-*.json`），
   翻页不重复提交 Paddle 任务；
2. 只取当前页，按上游策略筛出正文/标题/摘要/目录/图注块；相邻块作为消歧上下文，
   上一块没写完时标记续接；
3. 段落译文复用 `translations` 表缓存，`force` 时重译；
4. rpr 只重排这一页（`--page`），输出「原页 + 译文叠加层」的单页 PDF，
   按输入哈希缓存（`cache/page-*.pdf`）；
5. 前端用 PDF.js 把该页画到译文窗格的画布上，扫描件因此也能看到排版后的译文。

## 任务进度面板

导入任务在 `app_state['import-job:<key>']` 持久化，记录 OCR / 翻译 / 渲染 三阶段的
状态、消息、计数与历史执行摘要；运行的导入登记可取消上下文。

- `GET /v1/documents/{key}/job`：最近一次任务（进程重启后把未收尾的任务标为 interrupted）；
- `POST /v1/documents/{key}/job/cancel`：取消导入或后台渲染；
- 导入提交后，渲染在后台逐页进行并写回进度，阅读器打开即可看成品；
- 前端 `apps/web/src/components/DocumentJobDialog.tsx` 对应 Lee 的进度页：
  左侧封面/题录/下载，右侧概览、进度、文件三个标签与逐页覆盖。

## 译前领域与文档准备

- 导入翻译会从前两页 OCR 文本识别领域上下文，按模型、服务地址、推理强度及预览文本缓存；识别失败时保留通用翻译提示，不阻断导入。
- AI 设置提供 Lee 的 `off`、`artifacts_only`、`terms`、`terms+style`、`editorial` 五档。`off` 为默认值；术语建议不写入用户术语表，`terms+style` 会注入冻结的术语建议和风格指南。
- 术语预扫按 Lee 的 600 token / 12 段规则切批，含逐批 checkpoint、最多 8 路并发、严格 JSON、确定性过滤、按批投票及冲突译法记录；风格指南使用全文样本、领域上下文、通用规则及预扫术语生成，并独立缓存。
- `editorial` 已接入每批最多 40 项、最多 8 路并发的术语审定：专业术语锁定、出版物保留原文、人名/机构放开、普通词剔除；失败或漏审时不冻结术语库，重试仍复用成功的预扫批次。首现括注要求随首个匹配段传入翻译提示。RetainPDF 的完整术语审定报告、逐条人工裁决界面及首现括注质检尚未接入。
- ReadX 目前也没有可配置的领域规则档与自定义规则文本。其余 OCR 结构和专用修复差异见「已知边界」。

## 对齐工作清单

| 子任务 | 状态 | 下一步 / 完成条件 |
| --- | --- | --- |
| 1. OCR 段落筛选、公式与参考文献排除、确定性分批 | 已接入，仍有输入结构差异 | 用 RetainPDF 与 ReadX 的相同 PDF 对照 segment 清单与批次指纹 |
| 2. 领域识别与文档上下文 | 已接入 | 对照 RetainPDF 输入字段、截断上限与缓存指纹 |
| 3. 术语预扫、批次续接、投票与冲突项 | 已接入 | 对照清洗、边界匹配和目标译法验收的逐项差异 |
| 4. editorial 术语审定与术语统一 | 本次接入基础流程 | 补齐人工裁决/审定报告字段；对照部分失败、漏项、单复数和复合术语样例 |
| 5. 风格指南生成与注入 | 已接入基础流程 | 对照源提示词、Rule Profile、预算/截断及结构化结果格式 |
| 6. 翻译运行时（提示词、保护、分批、质检、修复、恢复） | 已实现主要路径 | 按源函数逐项做输入/输出对照，尤其是结果失败与续接恢复 |
| 7. checkpoint、缓存冻结及输入指纹 | 部分接入 | 对照源续跑状态机；验证复用条件及变更触发范围 |
| 8. PDF 回填与渲染 | 已接入 RetainPDF RPR 协议 | 对照多栏、旋转页、扫描底色、公式与溢出边界 |
| 9. 双端行为核对 | 编译通过，行为对照未完成 | 用固定论文集生成 ReadX/RetainPDF 逐阶段结果差异报告；清零未解释差异后再完成目标 |

## 已知边界

- Windows 与 macOS 的 PDF 导入现在都使用 PaddleOCR 的原始版面块，按内容哈希缓存 OCR 结果，进行布局区域与跨块/跨页续接判定，合并续接段翻译后再按原块切回，并保留页级块坐标及续接元数据。两端现已在首轮翻译后接入 OCR 文本乱码重建：候选预算、质量档开关、结构化 JSON 结果和原有质检均已对齐。RetainPDF 的完整重建依赖 Mathpix 公式映射、翻译产物状态和专用 provider 路由；这些字段尚未由 PaddleOCR 导入链提供，因此不能声称逐项完全相同。macOS 译文 PDF 导出已补上同一 RPR 输入协议，导出使用导入时保存的 OCR 页面和段落译文；剩余差异包含 macOS 打包资源配置与实际运行核对，以及 RetainPDF 结构化文档和完整修复阶段所依赖的数据。
- PDF 导入必须配置 PaddleOCR 与 AI；OCR 是远程服务，令牌只保存在本机
  `app/config.json` 的 `ocr` 段，不随响应回传。两者缺一，导入直接失败。
- 整页没有可译正文（公式、表格、纯图片页）或译文全空时，服务端原样抽取该页返回，
  阅读器显示「已保留原页」，后台渲染也把这页计为保留而不是失败。
- 质检偏保守（数字阈值、英文残留阈值），宁可漏报也不制造反复重译成本。
- 最终未译恢复与 RetainPDF 同档：fast 默认最多再试 4 项，quality/strict/full 默认 64 项；`RETAIN_TRANSLATION_FINAL_RECOVERY_MAX_ITEMS` 可覆盖。
- Agent 修复预算与 RetainPDF 同档：fast 只在存在阻塞级未译段时启动，最多处理 `min(8, 阻塞未译段数)` 个可修复候选；quality 按 `max(8, min(256, 阻塞数 × 2), min(64, 文档条目数 ÷ 80))` 计算。`RETAIN_TRANSLATION_AGENT_REPAIR_LIMIT` 可覆盖，`RETAIN_TRANSLATION_AGENT_REPAIR=false` 可关闭；格式、占位符或公式校验阻断的问题跳过 Agent 修复，之后进入最终未译恢复。
- 译文 PDF 的白底覆盖假设页面背景是白色；彩色/扫描底图需要 OCR 路线才能正确处理。
- 旋转页暂未做额外坐标变换（按 PDF.js 视口方向输出）。
