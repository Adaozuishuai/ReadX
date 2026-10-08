# CBCT 论文每日精读助手

围绕 CBCT（锥束 CT）重建的每日精读系统：**每天打开就有一篇值得读的论文，还有一个陪你逐步读懂它的向导**。每篇用同一套框架拆解，读过的论文自动形成可横向对比的结构化索引。

## 每天怎么用

macOS：双击 `~/Applications/CBCT每日精读.app`。从源码构建与安装：

```bash
native/build-app.sh
```

首次使用离线公式 OCR 时，在 macOS 安装本地依赖（首次安装会下载模型）：

```bash
native/scripts/install_formula_ocr.sh
```

Windows：安装 Node.js 18+ 后，在 `windows/` 目录运行 `npm install`、`npm start`。

新版工作台包含：

界面遵循 `assets/design/CBCT_Daily_FUN_Kids_4K.svg`：奶油色背景、黑色描边、粉彩卡片与顶部胶囊导航。Today 展示真实论文、阅读记录与关联 Idea；Library、Topics、Notebook 分别连接论文库、主题筛选和研究想法。研究画像在右上角头像，对比、导入、导出与 AI 设置在「更多」菜单。

对齐重设计已在 [Figma 可编辑文件](https://www.figma.com/design/vwOFX2jzCM2mewpmsSdrjO?node-id=5-12) 中建立，并同步到桌面：12 列网格按 5/3/4 分配、24px 列间距、三列共享 520px 高度、插画对齐知识卡片、40px 导航/操作控件。实际测量与截图见 [对齐复审](native/acceptance/2026-10-02/UI-DESIGN.md)。Figma Starter 插件额度用尽，手机稿最后的画布裁切修正仍待同步；实际手机页面已修正并验证。

- **今日发现**：每天打开时抓取 arXiv / PubMed 最近论文，按研究画像和阅读反馈排序，给出具体匹配理由；可精读、收藏、稍后读或忽略。
- **论文库**：搜索与筛选已保存论文，修改状态、标签、笔记和 AI 纠错；笔记自动保存；支持本地 PDF 导入和研究资产 JSON 导出。
- **研究想法（Ideas）**：记录研究问题、观察、假设、方法草图、验证实验与状态；附着可核对的原文摘录，或带来源标签的 AI 解释/研究建议；支持搜索、编辑、删除和 Markdown 导出。
- **迁移到我的研究**：精读室顶部进入，结合画像给出可复用、需适配、潜在冲突和待验证建议；每条包含原文依据与验证实验，可转成 Idea。
- **复现准备**：精读室顶部或「留笔记」进入；分析资源、环境、成本、关键缺失与风险。论文事实附逐字摘录，未知保持未知，AI 推断与核对行动单列；人工核对记录按分析版本保存，支持清单导出与转成待实验 Idea。
- **研究画像**：设置主题权重、数据集、方法、指标和算力；保存后推荐排序立即更新。
- **论文对比**：从论文库选择 2–8 篇，比较结构或实验协议，导出 Markdown / CSV；未知参数不会补造，历史笔记字段保留核对提示。
- **结果分析**：精读室「② 读原文」进入，抽取主表、消融、稳定性、泛化与效率证据；选择同表同列的两个方法计算差值，保留输入与页码。PSNR/dB 不计算百分比提升，作者统计措辞独立标识。
- **论文与代码**：精读室「② 读原文」进入，读取公开 GitHub 仓库中的 README/config/model/dataset/loss/train/infer 文件，固定 commit 与行号；映射同时验证论文摘录和代码片段。映射标为 AI 推测，人工核对另存说明；不会执行仓库代码。

精读室保留四步向导，增加 **TL;DR / 5 分钟 / Critical View / 方法与公式 / 实验抽取**。实验抽取增加基线类别。点击带摘录的 `Page N` 可以跳到 PDF 相应物理页并高亮证据；选中左侧原文或笔记，点「这里没懂」提问。Chat 支持范围与解释方式切换。

AI 助教使用 `app/config.json` 的兼容 API，保存配置即生效。没有可用原文时会停止事实分析；实验和迁移抽取会校验原文摘录、页码及事实字段中的数字，并最多自动修正两次。重新生成保留旧解析，个人笔记独立保存。

论文与笔记默认保存在本机；使用 AI 时会把当前论文证据和相关笔记发送到已配置的 API；迁移分析还会发送研究画像中的约束。Ideas 默认只在本机保存。论文发现优先筛选 MICCAI、CVPR 等期刊会议，arXiv 预印本独立列出；Semantic Scholar 限流时 macOS 端会尝试 Crossref 元数据兜底。PubMed 提供元数据，不保证可下载全文；请从论文库导入有权使用的 PDF。macOS 可用 Vision 识别扫描页，并提供本地公式 OCR。

源码仓库包含应用源码、测试、文档和设计资源。论文 PDF、阅读进度/笔记等本机数据、API 配置与密钥、模型文件、依赖目录和构建产物均保留在本机，不纳入源码仓库。


**② 对 ZCode 说（深度加工）**

- `精读 arxiv 2209.14540` 或 `精读 library/xxx.pdf` —— 产出带原文出处的完整精读笔记
- `NAF 和 <另一篇> 到底差在哪里？` —— 跨论文对比，回溯原文取证
- `把 xxx 加进待读队列` —— 编辑 queue.json

## 目录

- `native/` 原生 macOS 应用（Swift/SwiftUI 源码 + `build-app.sh` 打包脚本；运行日志 `native/boot.log`）
- `papers/` 每篇一篇笔记，文件名 `YYYY-短名.md`；`_template.md` 是框架模板
- `library/` 本机论文 PDF 原文与文本缓存（不纳入源码仓库）
- `queue.json` 待读队列（`arxiv` 编号条目，或无 arXiv 论文用 `id`+`pdfUrl`+`abstract` 手工条目）
- `INDEX.md` 对比索引 + 跨论文观察 + 待验证清单
- `app/config.example.json` 配置模板；实际 `app/config.json` 与 `app/data/` 中的本机配置和研究数据不纳入源码仓库
- `windows/` Windows 客户端源码、构建配置及移植一致性测试
- `assets/design/` 用户提供的 SVG 设计基准与 Figma 组件/布局源脚本、节点记录

## 精读框架（每篇一样）

1. **问题设定** —— 投影数量、角度范围、扫描几何、真实还是模拟数据
2. **方法核心** —— 体积怎么表示、投影约束怎么用、关键公式和模块各干什么
3. **实验可信度** —— 对比条件是否一致、细节是否丢失、时间和显存代价
4. **研究启发** —— 值得复现什么、哪些结论有待验证、与已读论文的联系

## 硬规则

- 笔记里每个事实都标注原文位置（节号 / 图表号），可核对
- 拿不到的信息写「未报告」，没把握的写「待验证」，数字禁止凭印象写
- 笔记用中文，专业术语保留英文

## 回归检查

macOS 回归检查需要 Xcode Command Line Tools：

```bash
native/test.sh                         # 原生离线回归
CBCT_LIVE_TESTS=1 native/test.sh       # 加上论文源官方 API smoke test
HF_HUB_OFFLINE=1 CBCT_FORMULA_OCR_SMOKE=1 native/test.sh # 可选：本地公式 OCR 真实 PDF 检查
```

Windows 逻辑与 renderer 回归（Node.js 18+）：

```bash
cd windows
npm ci
npm test
```

测试使用临时目录，保留正式论文和 API 配置。覆盖队列格式、去重、画像排序、反馈、持久化、证据范围与摘录校验、真实 PDF 以及失败降级。两项都只测「结构/安全是否成立」，真实模型生成质量需要另行使用论文样本验收。

## 真实模型验收

本轮使用公开的 NAF 论文和测试画像进行了实际 API 请求，发现并修复表格行列错配、摘录断行和数值证据不足的问题。主结果表的 25 组 PSNR/SSIM 已对照原 PDF 核对。单篇样本不代表模型总体正确率；公式原式仍需回 PDF 核对。

显式启用以下命令会向 `app/config.json` 中配置的服务发送公开 NAF 论文，不加载正式笔记、Ideas 或研究画像，也不覆盖正式解析：

```bash
CBCT_MODEL_TESTS=1 native/model-test.sh
# 可限定模块，例：CBCT_MODEL_MODULES=experiment,apply
# 仅复现分析：CBCT_MODEL_MODULES=reproduce CBCT_SKIP_CHAT=1
```

验收输出与失败记录见 `native/acceptance/2026-10-02/`，结论见 `REPORT.md`。

复现准备的真实模型过程、界面检查和剩余判断错误见 [复现准备验收](native/acceptance/2026-10-02/REPRODUCTION.md)。结构/引用通过不代表分析判断自动正确。

代码映射、结果分析的接受范围与失败记录见 [代码与结果验收](native/acceptance/2026-10-02/CODE-RESULTS.md)。SVG 界面的实际截图和导航检查见 [UI 验收](native/acceptance/2026-10-02/UI-DESIGN.md)。

复现准备分析只读取论文材料，不自动检查仓库或执行训练；未知成本不会按 GPU 型号补造。人工核对记录保存在 `app/data/reproduction/<key>.json`，不会加入 AI 请求。重新分析后，新版本从待核对开始，旧版本记录保留并随研究资产 JSON 导出。
