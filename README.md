# CBCT 论文每日精读助手（Windows 版）

围绕 CBCT（锥束 CT）重建的每日精读系统：**每天打开就有一篇值得读的论文，还有一个陪你逐步读懂它的向导**。每篇用同一套框架拆解，读过的论文自动形成可横向对比的结构化索引。

核心纪律是 **evidence-first**：论文事实必须能回到原文页码与逐字摘录，AI 推断、研究建议与个人笔记单独标识，拿不到的信息保持「未报告」，没把握的写「待验证」，数字禁止凭印象写。

> 本仓库**只包含 Windows 客户端**（Electron + TypeScript）。此前还有一版 macOS 原生应用（SwiftUI + PDFKit），已移除；Windows 版的纯逻辑由它逐条移植而来，本地数据格式与它完全一致。

## 怎么跑

需要 Node.js 18+。

```bash
cd windows
npm install
npm start          # 构建并启动
npm test           # 移植保真度回归
npm run dist:win   # 打 Windows 安装包（NSIS + 免安装版）
```

工作区根目录的解析顺序（`src/core/store.ts`）：

1. 环境变量 `CBCT_ROOT`
2. 从可执行文件所在目录向上最多 8 层，找含 `queue.json` 的目录
3. 当前工作目录

也可以从菜单「文件 → 切换工作区…」直接选包含 `queue.json` 的目录。

> 工作区数据（`queue.json` / `papers/` / `library/` / `app/data/*.json`）默认保存在本机，不进源码仓库。全文缓存 `library/text/<key>-v3.txt` 由应用生成；全新克隆缺少该缓存时，依赖它的 1 项端到端测试会失败，其余测试不受影响。

## 界面

奶油色背景、黑色描边、粉彩卡片，遵循 `assets/design/CBCT_Daily_FUN_Kids_4K.svg`。顶部导航六页：

- **今日论文** —— arXiv / PubMed 抓取、单源故障降级、首见日期追踪、今日新增计数、按研究画像排序的推荐理由
- **论文库** —— 搜索、状态切换、收藏、标签、笔记自动保存（500ms 防抖）、系统标签、回收站（标记删除，可恢复）、PDF 导入
- **对比** —— 2–8 篇横向对比、**固定列**、跨协议可比性警示、BibTeX / RIS 导出
- **趋势** —— 系统标签聚合、时间窗口 + 样本数 + 证据集合三要素、样本不足拒下判断、红线措辞自检
- **想法** —— 问题 / 观察 / 假设 / 方法 / 验证实验、五种状态、证据带来源类型
- **设置** —— API 地址 / 模型 / Key（Key 只写本地文件，不回显）

精读室从论文库条目进入：原文按页渲染 + 精读笔记六段落 + AI 助教（流式、范围切换、`Page N` 跳转高亮）。复现准备、结果分析、迁移建议、引用导出等入口在相应页面内。

## 目录

```
windows/
├── src/
│   ├── core/          纯逻辑（无 Electron 依赖，可单独测试）
│   │   ├── types.ts           数据模型（字段名与 JSON 一致）
│   │   ├── evidence.ts        evidence-first 校验链 ★ 核心
│   │   ├── markdown.ts / markdownTable.ts   块级 / GFM 表格解析
│   │   ├── notes.ts           精读笔记（papers/*.md）解析
│   │   ├── paper.ts           论文身份 / 去重 / 推荐排序
│   │   ├── idea.ts / reproduction.ts / result.ts   结构化校验器
│   │   ├── trend.ts / systemTags.ts / compare.ts / citation.ts
│   │   ├── store.ts           路径解析 + 原子写入 + 严格 JSON 读取
│   │   └── throttle.ts        写盘节流
│   ├── main/          Electron 主进程
│   │   ├── main.ts       窗口 + IPC 白名单
│   │   ├── preload.ts    contextBridge（渲染进程无 Node/fs）
│   │   ├── ai.ts         OpenAI 兼容流式请求
│   │   └── discovery.ts  arXiv / PubMed 抓取
│   ├── renderer/      渲染进程（app.ts + index.html + style.css）
│   └── tests/         移植保真度与回归测试
├── fixtures/          测试夹具（真实产物样本）
└── scripts/copy-static.js
```

顶层：

- `papers/` 每篇一篇精读笔记，文件名 `YYYY-短名.md`；`_template.md` 是框架模板
- `queue.json` 待读队列
- `INDEX.md` 对比索引 + 跨论文观察 + 待验证清单
- `app/config.example.json` 配置模板；实际 `app/config.json` 与 `app/data/` 为本机数据，不进仓库
- `assets/design/` 设计基准 SVG
- `PRD-路线.md` / `PRD-验收矩阵.md` / `PRD-差距分析.md` / `CODE-REVIEW.md` / `需求清单-*.md` 需求与审查文档（含 macOS 时代记录）

## 精读框架（每篇一样）

1. **问题设定** —— 投影数量、角度范围、扫描几何、真实还是模拟数据
2. **方法核心** —— 体积怎么表示、投影约束怎么用、关键公式和模块各干什么
3. **实验可信度** —— 对比条件是否一致、细节是否丢失、时间和显存代价
4. **研究启发** —— 值得复现什么、哪些结论有待验证、与已读论文的联系

## 硬规则

- 笔记里每个事实都标注原文位置（节号 / 图表号），可核对
- 拿不到的信息写「未报告」，没把握的写「待验证」，数字禁止凭印象写
- 笔记用中文，专业术语保留英文

## 可信度约束（移植时刻意保留）

这些是产品可信度的一部分，不是实现细节，**不放宽**：

- AI 回答必须引用真实存在的页码，否则拒绝保存（`validateEvidence`）
- 实验抽取的每条事实必须有页码 + 该页逐字摘录；字段里的数字必须被摘录支持
- 材料超限时如实披露只取了 N/M 页，并禁止据此断言「论文没有该内容」
- `References` 对任何检索范围都强制排除
- 方法名中间的数字不算测量值（`IntraTomo3D` 的 `3` 不算证据），型号数字（`RTX3090`、`1.2GB`）保留
- 流式中断的回答**不保存**——半个回答比没有回答更危险
- 损坏的 JSON **不静默回退**默认值（否则下次保存会覆盖用户数据）
- 结果表单元格不仅比对数字集合，还按表头列顺序逐字校验——否则列置换能整体通过
- 趋势样本数 < 5 时只报计数，不下趋势判断；缺口表述固定为「检索范围内未见」，不构成「首次」声明
- 可比性警示只在「两个以上不同的**已知**值」时触发；未知值不参与判断

## 安全基线

- `contextIsolation: true`、`nodeIntegration: false`，渲染进程只能通过 preload 暴露的 IPC 白名单访问能力
- CSP 限制 `default-src 'none'`、`connect-src 'none'`（渲染进程不发网络请求，抓取与 AI 都在主进程）
- Markdown 渲染不支持原始 HTML，全部转义后再插入
- 外链只放行 `http/https`，防止被诱导打开本地可执行文件
- API Key 不回传渲染进程

## 测试

```bash
cd windows
npm test
```

`npm test` 跑的是**移植保真度回归 + 模块回归**，覆盖表格解析、页码与引用校验、摘录 / 数字支持校验、范围披露、章节范围与 References 排除、论文去重与排序、Idea 生命周期、复现分析版本隔离、结果表列序校验、系统标签八类、趋势证据契约、引用导出等。

已知：全新克隆缺少 `library/text/2209.14540-v3.txt`（由应用生成、被 gitignore）时，`reproduction` 的 1 项真实缓存端到端测试会失败；该文件存在时全部通过。

## 已知限制

- **LaTeX 公式不做排版**：按源码转义展示并标注需核对原 PDF，没有行内公式排版
- **PDF 用系统阅读器打开**：无内置 PDF 面板，`Page N` 跳转是在左侧全文文本面板内滚动定位
- **OCR 未实现**：扫描版 PDF 依赖 macOS Vision，本版只读 `library/text/` 里已有的缓存
- **向量检索未移植**：Chat 只有单篇问答，跨论文扩展未实现
- **未移植的模块**：基线库、论文↔代码映射、方法公式工作流
- **未设置应用图标**：打包时用 Electron 默认图标
- **Windows 真机未验证**：产物可打包为真实 Windows 可执行文件，但开发环境为 macOS，双击安装、字体渲染、DPI 缩放等行为未经实机确认
