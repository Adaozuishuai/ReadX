# 全项目 Code Review（只列缺陷，未改任何源码）

审查对象：`cbct-reading`（SwiftUI + PDFKit 原生 macOS 应用 + `app/` 旧版 Electron/Web 兜底）
审查日期：2026-10-02 · 审查方式：逐文件阅读 + 可执行验证（编译真实源码复现）
基线：`native/test.sh` 实测 **32 passed / 0 failed / 1 skipped**（离线），下方缺陷均为现有测试**未覆盖**的部分。

---

## 0. 必须先纠正的前提（重要）

你给的审查清单（Dataset / DataLoader / 模型 / Loss / backward / AMP / PSNR / 显存 / 数据划分 …）预设这是一个**深度学习训练工程**。

**本项目不是。** 全仓库没有任何 `torch`、`nn.Module`、`DataLoader`、`optimizer`、`loss`、PSNR/SSIM/PSNR 计算代码、训练脚本或权重文件。它是一个**论文精读工具**：读 PDF 文本 → 调外部 LLM 做结构化抽取 → 用一套「原文摘录 + 页码 + 数字子集」校验器防止模型编造 → 落盘成 JSON/Markdown。

所以清单里的第 三/四/五/六/十三/十四 章（tensor shape、optimizer、AMP、Loss 尺度、metric data_range、模型 shape 表、`view()`/`contiguous`、显存）在本项目**无对应代码**，我不虚构问题。真正等价、且风险最高的审查对象是：

| 你的清单 | 本项目中的等价物 |
|---|---|
| 训练/验证/测试流程一致性 | 生成时的证据源 = 校验时的证据源 = 展示/落盘内容 |
| 数据范围/归一化不一致 | PDF 原文 → 文本抽取（含表格行重排）→ 模型 → 摘录归一化校验 |
| 「能跑但结果错」 | **摘录能通过校验，但数字被张冠李戴**（本项目已发生过一次） |
| metric 审查 | 引用页码覆盖率、数字子集包含、单位来源 |
| 数据泄漏 / 公平性 | 「论文事实」与「AI 推断」是否被混为一谈并落盘为事实 |
| checkpoint best 方向 | 落盘/历史归档/损坏保护、`fingerprint` 版本化 |

**样本量事实（你要求必须报告的那一项）**：
- 真实模型验收样本数 = **1 篇**（NAF，arXiv 2209.14540，11 页）。
- 代码/测试断言固定 `papers.count == 3`（`native/Tests/CBCTReadingTests/ResearchTests.swift:236`），但真实模型请求只发送 1 篇；`README.md:72` 已自认「单篇样本不代表模型总体正确率」。
- 预期测试样本数：无独立 test set 概念。**结论：没有任何跨论文评测，≥90% 引用追溯率、≥70% 推荐相关率的验收证据不存在**（`PRD-验收矩阵.md:43` 自认「未测量」）。

---

## A. 项目整体结论

- **能正常运行**：`native/test.sh` 32 项全过；`swift build -c release` 与打包脚本存在；真实 API 验收产物留在 `native/acceptance/2026-10-02/`。
- **结果可信度的问题**：存在 **4 个 Critical** 级缺陷，全部是**静默**的（不报错、不崩溃、现有 32 项测试全绿）：
  1. 每篇笔记的「我的批注」会不断重复追加同名小节，且应用的笔记解析器会**丢弃用户早期批注**（原生端，[C1]）；
  2. 结果表格的**行列错配无法被校验拦截**——这正是验收报告承认曾真实发生过的那类错误，机制至今存在（[C2]）；
  3. `app/server.js` 的 `progress[key] = ...` 可被 `__proto__` 污染，使**所有论文**瞬间变成 `done:true / step:9`（[C3]，已用真实 HTTP 请求复现）；
  4. `app/server.js` 不校验 `Origin` 且接受 `text/plain`，**任意网页都能把攻击者选定的文本写进你的研究笔记**（[C4]，已复现），而笔记随后会被送进 AI 提示词。
- **是否可以安全开始正式实验**：这套「实验」指论文精读/抽取，不是训练。可以在**人工逐条核对**的前提下继续使用；但**不要**把程序输出的 PSNR/SSIM 表、差值 Δ、复现成本当作可信结论。当前应视为「人机协同草稿工具」，不是「自动事实抽取器」。若你会一边开着应用一边用浏览器上网，请先修 [C3]/[C4]（或不要运行 `app/server.js` / Electron 兜底版，只用原生应用）。
- **抽取质量的实际水平（由 15 次真实运行的机器记录算出，见 [M25]）**：按模块的**结构校验通过率**为 apply 20% / experiment 25% / reproduce 50% / results 67%，总计 **25 通过 / 10 拒绝 = 71%**；**没有任何一次运行让全部模块同时通过**（最好的一次 `verified-v3` 跑了 8 个模块，experiment 与 apply 仍失败）。对外呈现的「全部模块通过」是 15 次运行的**并集**。这既证明校验器有效（拒绝记录都保留着），也说明**抽取稳定性远不足以作为自动化事实来源**。
- **样本量**：真实模型样本 = **1 篇论文**（NAF，11 页）。跨论文评测、关键事实引用覆盖率、≥90% 引用追溯率、≥70% 推荐相关率**均无证据**（`PRD-验收矩阵.md:43` 自认「未测量」）。
- **指标可信度（正面结论，见 [M22]）**：我用真实 `PDFLayout.text` 从源码 PDF 第 7 页抽出 Table 2，独立复核了笔记与三份抽取产物——**150/150 个 PSNR/SSIM 数值与原文逐格一致**（含被校验器拒绝的 `results-v2`——**该拒绝是正确的**：它的表头摘录只覆盖 FDK 一行，却写了 `[20]`/`[28]` 方法标签）。Table 1 的设置（50 views、TIGRE 3% 噪声、180°、探测器分辨率、Aorta 582 取 50、Adam 1e-3→1e-4、batch 2048、RTX 3090、192 points @ 128³）也在第 6 页逐条核对一致。**在「单篇 NAF 主结果表」范围内，表格数字完全可信**；但单篇样本不能支撑任何总体正确率声明。

---

## B. Critical 问题

### [C1] 「完成精读」回写批注使用错误的 Swift 正则，导致批注小节无限重复 + 已有批注被解析器丢弃
**文件**：`native/Sources/CBCTReading/Store.swift`
**位置**：`appendAnnotation`，第 652–665 行（问题在第 657 行）

**当前代码**：
```swift
func appendAnnotation(arxiv: String, noteId: String?, text: String) -> String? {
    guard let note = notes.first(where: { $0.id == noteId || (!arxiv.isEmpty && $0.meta["arxiv"]?.str == arxiv) }) else { return nil }
    let fileURL = papersDir.appendingPathComponent(note.file)
    guard var content = try? String(contentsOf: fileURL, encoding: .utf8) else { return nil }
    let stamp = "（\(Self.nowISO())·精读室）\(text)"
    if let range = content.range(of: "^## .*我的批注.*$", options: .regularExpression) {   // ← 无 .anchorsMatchLines
        content.replaceSubrange(range.upperBound..., with: "\n- \(stamp)" + content[range.upperBound...])
    } else {
        content = content.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n## 5. 我的批注\n- \(stamp)\n"
    }
    try? content.write(to: fileURL, atomically: true, encoding: .utf8)
    reloadAll()
    return note.id
}
```

**为什么错误**：
`^` / `$` 在 Swift 的 `NSRegularExpression`（`String.range(of:options:.regularExpression)` 底层就是它）里**默认只匹配整个字符串的首尾**。要按行匹配必须显式传 `.anchorsMatchLines`（等价于 JS 的 `/m`）。

**我用真实笔记文件做了可执行复现**（编译真实 `Store.appendAnnotation` 的正则逻辑跑 `papers/2022-naf.md`）：
```
has heading '## 5. 我的批注': true
SWIFT regex DID NOT MATCH -> 走进 else 分支，在文件末尾新追加一个 '## 5. 我的批注'
count of '## 5. 我的批注': 2
with .anchorsMatchLines matches: 1
```

**连锁后果（比重复更严重）**：`Store.splitSections`（第 321–337 行）遇到同名标题会**覆盖** `out[c]`：
```swift
func flush() { if let c = current { out[c] = buf.joined(...) } ... }
```
于是 `n.sections["annotations"]` 最终等于**最后一个**批注小节。用户最初写在 `## 5. 我的批注` 里的原始想法，从应用视角**消失了**，而它还会被塞进发给 AI 的上下文（`AIService.swift:45-47` 用 `n.sections["annotations"]`）和 `stepQuestions`（`Store.swift:875-877`）。

**可能影响**：
- 每完成一次精读，笔记多一个重复小节，文件持续膨胀、越读越乱；
- 用户自己的旧批注在应用内不可见、且不会被送入 AI 上下文 → 「我的批注就是以后跨论文比较的底牌」（`Views.swift:577`）这句话实际不成立；
- 是**静默**的：无报错、无日志、现有 32 项测试全绿（我 grep 确认 `appendAnnotation` **没有任何测试引用**，只有 `.build/` 里的符号）。

**建议修改**（最小改动，仅加一个选项）：
```diff
-        if let range = content.range(of: "^## .*我的批注.*$", options: .regularExpression) {
+        if let range = content.range(of: "^## .*我的批注.*$", options: [.regularExpression, .anchorsMatchLines]) {
```
同时建议（非必须）在 `splitSections` 里把重复标题改为**拼接**而不是覆盖，作为第二道防线：
```diff
-        func flush() { if let c = current { out[c] = buf.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }; buf = [] }
+        func flush() {
+            if let c = current {
+                let piece = buf.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
+                if let old = out[c], !old.isEmpty, !piece.isEmpty { out[c] = old + "\n" + piece } else if !piece.isEmpty { out[c] = piece }
+            }
+            buf = []
+        }
```
并补一条回归测试：对真实笔记调用 `appendAnnotation` 两次，断言 `## 5. 我的批注` 只出现一次、且原批注仍在 `sections["annotations"]` 中。

---

### [C2] 结果表校验无法发现「行列错配」，而 UI 却把差值当程序计算结果展示

**文件**：`native/Sources/CBCTReading/ResultModels.swift`
**位置**：`ResultsAnalysis.validate`，第 73–83 行

**当前代码**：
```swift
for row in table.rows {
    guard row.evidence.page != nil, !row.method.isEmpty,
          Evidence.normalized(row.evidence.excerpt ?? "").contains(Evidence.normalized(row.method)),
          Set(row.cells.map(\.columnID)) == Set(table.columns.map(\.id)), row.cells.count == table.columns.count else { try fail("行标签或单元格不完整：" + row.id); return }
    let numbers = Evidence.numbers(row.evidence.excerpt ?? "")
    for cell in row.cells {
        guard cell.value != nil, !Evidence.numbers(cell.valueText).isEmpty, Evidence.numbers(cell.valueText).isSubset(of: numbers) else { try fail(...); return }
        ...
    }
}
```

**为什么错误**：
校验只做了三件事：页码存在、方法名出现在摘录里、**单元格数字是该行摘录中出现的某个数字**。它**没有**校验数字出现在行内的**位置/顺序**。一行表里有 2×N 个数字时（NAF Table 2 每个方法行有 10 个数字），任何**列置换**都仍然满足「数字 ∈ 该行数字集合」。

**可执行验证**（构造真实 NAF Table 2 数据，正确赋值 vs. 转置赋值，跑真实 `ResultsAnalysis.validate`）：
```
correct:    PASSED validation
transposed: PASSED validation          ← 列被整体错位，校验全过
naf-row-holds-FDK-numbers: REJECTED    ← 换成别的方法的数字才会被拦
```
（第一版测试因 `unit="dB"` 被单位校验拦下，把 unit 设为「论文未说明」后即为上表——恰好说明**唯一拦住转置的是单位字符串巧合，不是结构性校验**。）

**可能影响**：
- 这正是 `native/acceptance/2026-10-02/REPORT.md:45` 记录的**真实发生过的失败**：「首次实验输出把 NAF Chest 写成 12.11/.21」。当时的修复是「改为按物理行读取」，但**转置仍可能发生**，只是概率降低；
- `ResultViews.swift:76-80` 会把 A−B 当作「**程序计算**」结果展示，并显示相对百分比；一旦来源列错位，差值本身就是错的，而界面上带着「数字/摘录已作结构校验」的背书；
- 用户据此判断「NAF 比 SART 高 3.07 dB」这类结论的可信度直接被污染。

**建议修改**（保持原有设计，增加位置敏感的一项检查）：
在 `validate` 内、逐行数字检查之后，追加以「行内数字序列」为锚的校验——即要求单元格的值按其在行摘录中**出现的先后顺序**递增（允许误差项插入），这是一个廉价且强力的转置检测：
```diff
             let numbers = Evidence.numbers(row.evidence.excerpt ?? "")
+            // 位置敏感检查：单元格值在行摘录中必须按出现顺序排列（防止列置换）
+            let excerpt = row.evidence.excerpt ?? ""
+            var cursor = excerpt.startIndex
+            for cell in row.cells {
+                guard let found = excerpt.range(of: cell.valueText, range: cursor..<excerpt.endIndex) else {
+                    try fail("单元格数值未按行内出现顺序排列（疑似列错位）：\(row.id)/\(cell.columnID) = \(cell.valueText)")
+                    return
+                }
+                cursor = found.upperBound
+            }
             for cell in row.cells {
```
（注意：`valueText` 可能是 `.958` 这类省略前导零记法，`range(of:)` 用逐字匹配正好符合现有「保留原记法」的约束；如担心归一化差异，可退化为对 `evidence.excerpt` 中数字 token 序列做同样的一次性顺序比对。）
并补回归测试：把 C2 验证脚本里的 `transposed` 用例固化为 `XCTAssertThrowsError`（当前它是 PASS）。

---

### [C3] `app/server.js` 原型链污染：一个请求把所有论文标记为「已读」

**文件**：`app/server.js`
**位置**：`/api/progress` 390–401、`/api/reflect` 403–413（`readBody` 334 无 `__proto__` 过滤）

**当前代码**：
```js
if (req.method === 'POST' && p.startsWith('/api/progress/')) {
  const key = decodeURIComponent(p.split('/')[3]);          // 未做任何字符/白名单校验
  const body = await readBody(req);
  const progress = loadProgress();
  const cur = progress[key] = progress[key] || { startedAt: ... };   // key='__proto__' 时 cur === Object.prototype
  if (body.step) cur.step = Math.max(cur.step || 0, body.step);
  ...
```

**为什么错误**：`progress` 是普通对象字面量，`progress['__proto__']` 返回 `Object.prototype`（真值），于是 `cur` **就是** `Object.prototype`，后续赋值写到了全局原型上。`readBody` 的 `JSON.parse` 也没有 `__proto__` reviver，`{...cur.reflections, ...body.reflections}` 是第二条路径。

**我的独立复现**（用真实 `app/server.js`、真实 HTTP 请求、真实 `queue.json`）：
```
curl -X POST --data '{"step":9,"done":true}' http://127.0.0.1:5391/api/progress/__proto__
-> {"ok":true,"progress":{"step":9,"doneAt":"..."}}

GET /api/state
-> every paper done: [('2022-naf', True, 9)]
-> today: intratomo-2021          # 用户的 NAF 精读被跳过
```
并确认 `JSON.stringify(progress)` 输出 `{}`——**文件看起来是干净的**，所以重启后症状消失、无从追查。

**可能影响**：所有论文被标记为已读、阅读进度/连击失真、`computeToday` 选错今日论文；`Object.prototype.doneAt` 还会泄漏进任何 `{...}` 展开。这是**静默的数据污染**，与「实验结果可信度」直接冲突。

**建议修改**：
```diff
+const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
+function safeKey(k) { return UNSAFE.has(k) ? null : String(k); }
+function parseBody(data) { return JSON.parse(data || '{}', (k, v) => UNSAFE.has(k) ? undefined : v); }
-  const key = decodeURIComponent(p.split('/')[3]);
+  const key = safeKey(decodeURIComponent(p.split('/')[3] || ''));
+  if (!key) return json(res, 400, { error: 'bad_key' });
   const progress = loadProgress();
-  const cur = progress[key] = progress[key] || { startedAt: new Date().toISOString() };
-  if (body.step) cur.step = Math.max(cur.step || 0, body.step);
-  if (body.reflections) cur.reflections = { ...(cur.reflections || {}), ...body.reflections };
+  if (!Object.prototype.hasOwnProperty.call(progress, key)) progress[key] = { startedAt: new Date().toISOString() };
+  const cur = progress[key];
+  if (typeof body.step === 'number' && Number.isFinite(body.step)) cur.step = Math.max(cur.step || 0, body.step);
+  if (body.reflections && typeof body.reflections === 'object') {
+    cur.reflections = { ...(cur.reflections || {}) };
+    for (const [rk, rv] of Object.entries(body.reflections)) if (!UNSAFE.has(rk)) cur.reflections[rk] = rv;
+  }
```
（`/api/reflect` 同样处理。`readBody` 改用 `parseBody`。）

---

### [C4] 无 `Origin`/`Sec-Fetch-Site` 校验 + 接受 `text/plain` → 任意网页可写入你的研究笔记（CSRF）

**文件**：`app/server.js`
**位置**：`readBody` 330–337、路由入口 349–351、`/api/reflect` 403–414、`appendAnnotation` 244–257

**当前代码**：
```js
function readBody(req) {                       // 完全不看 Content-Type
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
```
```js
async function route(req, res) {
  const url = new URL(req.url, 'http://x');    // 从不检查 Origin / Referer / Sec-Fetch-Site
```

**为什么错误**：`text/plain` 属于 CORS「简单请求」，浏览器**不会预检**；服务端又没有同源校验。绑定 `127.0.0.1` 只能阻止外部主机直连，**挡不住用户自己已打开的浏览器**。

**我的独立复现**（真实服务、带伪造外部 Origin、未做任何修改即写入成功）：
```
curl -X POST -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' \
  --data '{"arxiv":"2209.14540","noteId":"2022-naf","text":"CSRF injected bullet"}' \
  http://127.0.0.1:5391/api/reflect/2209.14540
-> {"ok":true,"writtenTo":"2022-naf"}
-> papers/2022-naf.md 末尾新增：- （2026-10-02·精读室）CSRF injected bullet
```
配合 [C3]，同一手法可把全部论文标记为已完成。

**可能影响**：恶意页面可持久化任意文本到 `papers/*.md`；这些笔记会被送入 AI 提示词（`AIService.paperContext`），且是用户的核心研究资产。`/api/restart`、`/api/fetchpdf` 也有副作用。

**建议修改**：
```diff
+function sameOrigin(req) {
+  const o = req.headers.origin;
+  if (o && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return false;
+  const s = req.headers['sec-fetch-site'];
+  if (s && s !== 'same-origin') return false;
+  return true;
+}
 async function route(req, res) {
   const url = new URL(req.url, 'http://x');
   const p = url.pathname;
+  if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'forbidden_origin' });
```
并在 `readBody` 中强制 `application/json`（不满足返回 415），持续保留 `Access-Control-Allow-Origin` 不设置（现状已如此）。

---

## C. High 问题

### [H1] `esc()` 未转义引号，却被用于 HTML 属性上下文 → 摘要/标题里的 `"` 可注入任意属性（XSS）

**文件**：`app/public/app.js`
**位置**：定义在第 3 行，危险使用在第 296、312、313、314、351、359 行

**当前代码**：
```js
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```
```js
// 296:
<div class="selectable" data-ctx="${esc((setup || abstract || '').slice(0, 1500))}">...
// 312 / 313 / 314 / 359 同样把笔记/PDF/元数据文本放进 data-ctx="..."
// 351:
const pdfIframe = url => `<iframe class="pdf-frame" src="${esc(url)}" title="论文 PDF"></iframe>`;
```

**为什么错误**：`esc` 转义了 `& < >`，但**没有转义 `"` 和 `'`**。属性值用双引号包裹时，正文里的一个 `"` 会提前闭合属性，后面内容被解析为新属性，而结果是通过 `innerHTML` 注入的。

**可执行验证**（同一函数逻辑）：
```
输入 abstract = 'Sparse-view CBCT " onmouseover="alert(1)" x="'
输出: <div class="selectable" data-ctx="Sparse-view CBCT " onmouseover="alert(1)" x="">
```
即 `onmouseover` 成为真实事件处理器。

**为什么这里不只是理论问题**：`abstract` / `title` 来自 arXiv / PubMed 的**外部 API**（`DiscoveryService.swift`），note 的 `sections` 来自 AI 生成文本与用户输入。external 文本未经任何清洗就进入这些属性。原生 Swift 端没有这个问题（用 `RichText`/`Text`），**只有 `app/` 兜底版受影响**。

**可能影响**：恶意/异常摘要文本可在 127.0.0.1:5218 页面内执行任意 JS；由于该服务同时暴露了 `/api/ask`（携带 API Key 向用户付费接口发请求）与文件写入端点，实际影响超出「弹窗」级别。Electron 侧因 `contextIsolation: true, nodeIntegration: false` 限制了危害，但浏览器兜底模式下是完整同源脚本执行。

**建议修改**（最小改动）：
```diff
-const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
+const esc = s => String(s == null ? '' : s)
+  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
+  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
```
（`esc` 仅用于文本节点与属性，转义引号对文本节点语义无影响。更稳妥的做法是再引入一个 `escAttr` 专用于属性，并避免 `innerHTML` 拼接。）

---

### [H2] `allPapers` / `rankedPapers` / `savedPapers` 既是计算属性又是 O(n²)，被视图在一次渲染里重复触发

**文件**：`native/Sources/CBCTReading/ResearchStore.swift`（33–43、56–65 行）、`native/Sources/CBCTReading/PaperIdentity.deduplicate`（`ResearchModels.swift:65-82`）、调用点 `native/Sources/CBCTReading/WorkspaceViews.swift`（56–61、84、90、146–153 行）、`Store.swift:353`

**当前代码**：
```swift
// ResearchStore.swift:33
var allPapers: [QueueEntry] {
    let noteEntries = notes.map { ... }
    return PaperIdentity.deduplicate(queue + noteEntries + discovery.papers)   // 每次访问都全量去重
}
// ResearchStore.swift:56
var rankedPapers: [RankedPaper] {
    var negative: [String: Int] = [:]
    for paper in allPapers where state(paper.key).relevance < 0 { ... }        // allPapers 第 1 次
    return allPapers.filter { ... }.map { ... }.sorted { ... }                  // allPapers 第 2 次
}
// ResearchStore.swift:41
var savedPapers: [QueueEntry] {
    allPapers.filter { queue.contains(where: { PaperIdentity.same($0, paper) }) || ... }   // 又 1 次 + 每篇一次线性扫描
}
```
`PaperIdentity.deduplicate` 是 `out.firstIndex(where: { same($0, p) })` —— 每篇都要和已保留的全部比较，`same()` 内部还会重复做 `arxiv()/doi()/title()` 正则与 unicode scalar 过滤。

**实测（编译 `deduplicate` 原始逻辑跑真实 `app/data/discovery.json`，40 篇）**：
```
discovery papers: 40
deduplicate(): 19.673 ms per call
  -> HomeView 一次渲染里 rankedPapers 至少读 2 次 => ~39 ms/渲染，仅去重
```
而 `WorkspaceViews.swift:57-59` 在同一个 `HStack` 里连续读 `rankedPapers`（计数）、`savedPapers`（每次内部又调 `allPapers`）、`rankedPapers`（`filter`），第 84 行**再读一次** `rankedPapers`，第 90 行又在其中线性查找。`savedPapers` 还叠加 `queue.contains(where:)` 的 O(n·m)。再加 `Store.swift:353` 的 `computeToday()` 也读 `rankedPapers`（而 `computeToday` 会在**每次 `mutateLibrary`**里被调用）。

**可能影响**：论文库到数百篇（多个 arXiv 主题订阅很容易到 300+）时，首页每次重绘数百毫秒；在文件写入频繁时（见 H3）造成输入卡顿。纯 CPU、无缓存，是明确的性能/内存放大问题。

**建议修改**（最小改动，不改变任何可见行为）：
1. 在 `Store` 中增加缓存字段并在数据变更处失效，把 `allPapers` 从「每次重算」变成「变更时算一次」：
```diff
+    private var cachedAllPapers: [QueueEntry]?
+    private var cachedRanked: [RankedPaper]?
     var allPapers: [QueueEntry] {
+        if let cachedAllPapers { return cachedAllPapers }
         let noteEntries = notes.map { ... }
-        return PaperIdentity.deduplicate(queue + noteEntries + discovery.papers)
+        let result = PaperIdentity.deduplicate(queue + noteEntries + discovery.papers)
+        cachedAllPapers = result
+        return result
     }
```
   并在 `reloadAll()`、`refreshDiscovery`、`addToQueue`、`importPDF`、`saveProfile`、`mutateLibrary` 中置 `cachedAllPapers = nil; cachedRanked = nil`。
2. 视图层把 `let ranked = store.rankedPapers` 提取一次、复用（`WorkspaceViews.swift:57-59, 84, 90`），不要在同一次 body 里重复读计算属性。
3. 把 `PaperIdentity.deduplicate` 的 O(n²) 换成索引表：以 `arxiv` / `doi` / 规范化标题为 key 建 `[String: Int]`，只对标题兜底分支做线性比较。

---

### [H3] 每次按键都做「全量 JSON 编码 + 原子写盘 + computeToday」

**文件**：`native/Sources/CBCTReading/WorkspaceViews.swift`（207、210、213 行）、`native/Sources/CBCTReading/Views.swift`（552–556 行）、`native/Sources/CBCTReading/ResearchStore.swift`（12–19、49–55 行）

**当前代码**：
```swift
// WorkspaceViews.swift:210
TextEditor(text: $personalNote).frame(height: 110).border(Color.line)
    .onChange(of: personalNote) { value in if loaded { store.mutateLibrary(paper.key) { $0.notes = value } } }
// :213 纠错文本同理；:207 标签同理
```
```swift
// ResearchStore.swift:49
func mutateLibrary(_ key: String, _ mutation: (inout LibraryState) -> Void) {
    var value = state(key); mutation(&value)
    value.updatedAt = ISO8601DateFormatter().string(from: Date())
    libraryState[key] = value
    persist(libraryState, to: libraryStateURL)   // 全量 prettyPrinted JSON + .atomic 写
    computeToday()                               // 内部可能触发 rankedPapers（见 H2）
}
```
```swift
// Views.swift:553
.onChange(of: doubt) { v in
    session.drafts["doubt"] = v
    store.saveProgress(key: session.ref.key) { $0.reflections = ... }   // 每字符一次 persist
}
```

**为什么有问题**：
- 用户每敲一个字符 → 全量重编码 `library.json` / `progress.json` + `write(options: .atomic)`（写临时文件 + rename）。论文库/进度越大越慢；
- 叠加 H2，按键路径上还可能触发 `rankedPapers` 的全量去重；
- 仓库自己在 `Store.swift:244-245` 明确写了警告：「Foundation `attributesOfItem` 也会读扩展属性，在 **File Provider 支持的 Desktop 目录**上可能无限阻塞」。当前数据根目录正是桌面路径（`Store.findRoot()` → `Desktop/07-代码与项目数据/...`），说明作者已知这类目录 I/O 有风险，却在按键热路径上做全量原子写。

**可能影响**：在 iCloud/File Provider 同步的桌面上输入笔记时明显卡顿甚至卡死；磁盘写入放大；`progress.json` 与 `library.json` 的写竞争窗口被放大（虽为原子写，但「后写覆盖先写」会丢更新，属于并发写丢失问题）。

**建议修改**（最小改动，保留自动保存语义）：
```diff
+    private var pendingPersist: [URL: Task<Void, Never>] = [:]
     // 用 0.4s 去抖替换逐字符写盘
+    func persistDebounced<T: Encodable>(_ value: T, to url: URL) {
+        pendingPersist[url]?.cancel()
+        pendingPersist[url] = Task { [weak self] in
+            try? await Task.sleep(nanoseconds: 400_000_000)
+            if Task.isCancelled { return }
+            _ = self?.persist(value, to: url)
+        }
+    }
```
`mutateLibrary` / `saveProgress` 改用 `persistDebounced`；在 `goHome()`、`finishReading()`、`applicationWillTerminate`（或 `.onDisappear`）处强制 flush 一次，避免退出丢最后一次编辑。若不想引入去抖，最低限度是把 `computeToday()` 从 `mutateLibrary` 里移出，改为在状态变化（status/relevance/ignored）时调用。

---

### [H4] `appendAnnotation`（JS 版）把用户文本当替换模式 → `$&` / `` $` `` / `$'` 被展开，笔记被污染

**文件**：`app/server.js:250-253`

**当前代码**：
```js
const stamp = `（${todayISO()}·精读室）${text}`;
if (/^## .*我的批注/m.test(content)) {
  content = content.replace(/(^## .*我的批注.*$)/m, `$1\n- ${stamp}`);   // stamp 也参与替换模式解释
}
```

**为什么错误**：`String.replace` 的**替换字符串**会解释 `$&`、`` $` ``、`$'`、`$1`。用户的批注文本里出现这些字符就会被展开。

**我的独立复现**（Node，真实逻辑）：
```
输入 text = '价格是 $& 而 $1 也特殊'
输出 -> - （2026-10-02·精读室）价格是 ## 5. 我的批注 而 ## 5. 我的批注 也特殊
```
即把小节标题复制进了批注正文；`` $` `` / `$'` 更会把**整篇剩余笔记**复制进去。注意这与 [C1]（Swift 端正则缺 `.anchorsMatchLines`）是**两个独立缺陷**，两条路径都要修。

**建议修改**：
```diff
-  content = content.replace(/(^## .*我的批注.*$)/m, `$1\n- ${stamp}`);
+  content = content.replace(/(^## .*我的批注.*$)/m, (m0) => `${m0}\n- ${stamp}`);
```

---

### [H5] `inline()` 的 Markdown 链接净化可被绕过 → `href` 注入可执行属性

**文件**：`app/public/app.js:15-22`

**当前代码**：
```js
function inline(s) {
  s = esc(s);                                     // 先转义（不含引号）
  ...
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
    /^https?:/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t);
```
**为什么错误**：URL 捕获类是 `[^)\s]+`，允许 `"`；而它在 `esc()` **之后**被拼进 `href`，等于未经转义直接进入 HTML。

**我的独立复现**：
```
inline('[click](https://a.com"onmouseover="alert(1))')
-> <a href="https://a.com"onmouseover="alert(1" target="_blank" rel="noopener">click</a>
```
**可达性**：`papers/*.md` 正文与 `queue.json` 的 `why/abstract` 都会被 `md()` → `innerHTML` 渲染；配合 [C4] 可远程写入笔记，构成完整攻击链。

**建议修改**：
```diff
-  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
-    /^https?:/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t);
+  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
+    /^https?:\/\/[^\s"'<>]+$/.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : t);
```
并建议在 `app/public/index.html` 增加 CSP（`default-src 'self'; object-src 'none'`）。

---

### [H6] 手工队列条目（无 arXiv）在兜底版里不可点击，点击抛 `TypeError`

**文件**：`app/public/app.js:187`（渲染）、`209-212`（点击）

**当前代码**：
```js
st.queue.map(q => `<li data-q="${esc(q.arxiv)}" ...>`)          // 手工条目 q.arxiv === undefined → data-q=""
...
v.querySelectorAll('li[data-q]').forEach(li => li.onclick = () => {
  const q = S.state.queue.find(x => x.key === li.dataset.q || x.arxiv === li.dataset.q);   // 用 '' 查找 → undefined
  openReader({ key: q.key, ... });                                                          // TypeError
```
服务端 `queueKey(q)`（`app/server.js:108`）是对的（`q.arxiv || q.id`），UI 用错了字段。

**为什么不是理论问题**：`queue.json` **当前就带这样一条**（`id: "intratomo-2021"`，无 `arxiv`）。我的独立复现：
```
risky: data-q=""  -> find() 返回 undefined -> TypeError: Cannot read properties of undefined (reading 'key')
```
即「待读队列」第一行是死链接；只有「今日论文」卡片仍可用（数据来自 `state.today`）。

**建议修改**：
```diff
-      st.queue.map(q => `<li data-q="${esc(q.arxiv)}" class="${q.hasNote ? 'done' : ''}">
+      st.queue.map(q => `<li data-q="${esc(q.key)}" class="${q.hasNote ? 'done' : ''}">
```

---

### [H7] `library/` 不存在时 `/api/state` 直接 500，兜底版整体不可用

**文件**：`app/server.js:261-265`（`findLocalPdf` 无保护）、`366-368`（`/api/state` 调用它）

```js
function findLocalPdf(arxiv) {
  if (!arxiv) return null;
  const hit = fs.readdirSync(LIB_DIR).find(...);   // 目录不存在即抛 ENOENT
```
`.gitignore` 忽略 `/library/text/`，`server.js` 只创建 `DATA_DIR`（第 22 行），因此「刚 clone 还没有 library/」是完全正常的状态。

**我的独立复现**（无 `library/` 目录）：
```
GET /api/state -> HTTP 500
{"error":"Error: ENOENT: no such file or directory, scandir '.../library'\n at findLocalPdf (app/server.js:263)"}
```
前端 `init()` 随即显示「加载失败」并停止渲染（`app/public/app.js:469-471`），**并且把绝对路径与调用栈返回给客户端**。

**建议修改**：
```diff
 function findLocalPdf(arxiv) {
   if (!arxiv) return null;
-  const hit = fs.readdirSync(LIB_DIR).find(f => f.includes(arxiv) && f.endsWith('.pdf'));
-  return hit || null;
+  let files;
+  try { files = fs.readdirSync(LIB_DIR); } catch { return null; }
+  return files.find(f => f.includes(arxiv) && f.endsWith('.pdf')) || null;
 }
```

---

### [H8] `sendFile` 未挂 stream error 监听 → 一个不可读文件直接终止整个 node 进程

**文件**：`app/server.js:338-342`

```js
function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);            // ReadStream 的 'error' 无人监听
}
```
`route()` 外层的 `.catch()`（460）救不了——错误发生在 `route` 返回之后。`existsSync + statSync().isFile()` 是 TOCTOU 检查，EACCES / 竞态删除 / EISDIR 都会走到未保护的 stream。

**我的独立复现**（真实服务 + `chmod 000` 的静态文件）：
```
before: server alive
GET /noread.js -> curl HTTP 000（连接被切断）
after: 端口不再监听；日志为 "Emitted 'error' event on ReadStream instance" + "Node.js v23.11.0"
```
**可能影响**：`library/` 或 `public/` 中任何一个权限异常文件都会让整个应用**退出**（而非返回 404）。

**建议修改**：
```diff
 function sendFile(res, file) {
   const ext = path.extname(file).toLowerCase();
+  const stream = fs.createReadStream(file);
+  stream.on('error', () => { if (!res.headersSent) json(res, 404, { error: 'not_found' }); else res.destroy(); });
   res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
-  fs.createReadStream(file).pipe(res);
+  stream.pipe(res);
 }
```

---

### [H9] 非原子写入 + 静默吞掉解析错误 → 一次损坏就让全部阅读历史消失

**文件**：`app/server.js:97-100`（`loadProgress`/`saveProgress`）、`249-256`（`appendAnnotation`）

```js
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }   // 解析失败 → 当作空
}
function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }   // 原地截断写
```
`progress.json` 承载**全部**阅读历史、反思与审稿对话（真实文件 6.4 KB 不可再生文本），且没有任何备份。

**我的独立复现**：
```
把 progress.json 写成 "NOT JSON{"
GET /api/state -> progress 被当作 {}（无任何报错）
再发一次 POST /api/progress/k9 -> 文件被整体覆盖为 {"k9":{...}}，历史全部丢失
```
并发写同样有 read-modify-write 竞争（`/api/reflect` 并行写入时批注顺序错乱）。

**建议修改**：
```diff
+function atomicWrite(file, text) {
+  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
+  fs.writeFileSync(tmp, text);
+  fs.renameSync(tmp, file);
+}
-function saveProgress(p) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2)); }
+function saveProgress(p) { atomicWrite(PROGRESS_FILE, JSON.stringify(p, null, 2)); }
 function loadProgress() {
-  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }
+  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
+  catch (e) {
+    if (e.code !== 'ENOENT') { console.error('progress.json 解析失败，已保留原文件：', e.message); throw e; }
+    return {};
+  }
 }
```
（原生 Swift 端在这一层是好的：`persist` 用 `.atomic`，且解析失败会保留原文件并报错。这是**两端不对称**。）

---

## D. Medium / Low 问题

> **所属端**：M1/M5–M11/M13/M14/M26 在 `app/` 兜底端；M2–M4/M12/M16–M20 在原生 Swift 端；M15/M21/M22/M25/M27 为跨端或工程规范；**M23/M24 为验收产物与文档的一致性**（`native/acceptance/`）。

### [M1] 兜底版无法从 PDF `<iframe>` 内选中文本，「在 PDF 里选中」这条提示文案必然失效

**文件**：`app/public/app.js:117-122`（`contextOf`）、`:330`（提示文案）
`window.getSelection()` 在父文档里取不到 `<iframe>` 内的选区，因此「在 PDF 里读到可疑处，回左侧选中对应句子问助教」在浏览器兜底模式下**必然无效**，只能选左侧文本。原生端通过 `PDFKitView` 的 `.PDFViewSelectionChanged` 通知正确处理（`NativeViews.swift:203-209`），两端行为不一致。
**建议**：文案与行为对齐，或明确标注「兜底版不支持 PDF 内选中」。

### [M2] `Step2`「这里没懂」发送的「上下文」永远是文档开头 1200 字符，与选中位置无关

**文件**：`native/Sources/CBCTReading/NativeViews.swift:72-79`
```swift
@objc private func askTapped() {
    let r = selectedRange()
    guard r.length >= 2 else { return }
    let s = (string as NSString).substring(with: r)
    let ctx = String(string.prefix(1200))     // ← 与选区无关，恒为文档头部
    onAsk?(s, ctx)
    pill.isHidden = true
}
```
JS 版同病：`app/public/app.js:117-122` 的 `contextOf()` 取 `holder.dataset.ctx`（即 `esc(...).slice(0,1500)` 的 pane 头部）或 `pane.textContent.slice(0,900)`，同样是片段开头。
**影响**：发给模型的「它所在的上下文」是噪声，不是选区附近语义。所幸 `Store.runAsk` 还会用 `Evidence.select(text, query: question + selection)` 单独检索证据，因此不是致命的错误事实输入，但功能名不副实、浪费 token。
**建议**：用选区所在的 `NSRange` 向两侧扩展固定字符数（如各 400 字）。
```diff
-        let ctx = String(string.prefix(1200))
+        let ns = string as NSString
+        let lo = max(0, r.location - 400), hi = min(ns.length, r.location + r.length + 400)
+        let ctx = ns.substring(with: NSRange(location: lo, length: hi - lo))
```

### [M3] `scope=Appendix` 在真实论文上恒为空，被当成「原文不可用」报错

**文件**：`native/Sources/CBCTReading/ResearchModels.swift:177-207`，触发点 `Store.swift:594/611`
真实 NAF PDF 上实测各 scope 覆盖：
```
total chars: 26670
scope=全文       -> 26670 chars, pages=[1..11]
scope=Method     -> 13608 chars, pages=[2,3,4,5,6,7,8]
scope=Experiment ->  2503 chars, pages=[6]
scope=Appendix   ->     0 chars, pages=[]
scope=Figure     ->  1558 chars, pages=[3,7,8,9]
```
`Method` 还包含 page 5–8（References 段在内），因为 `active` 只在识别到下一个 major heading 时才为 false，否则一页页持续累加。`Store.runAsk` 对空 `source` 直接 `throw DiscoverySource.invalidSource()`，UI 显示「论文中未找到可用的原文证据」，把「该论文没有附录」说成了「证据不可用」。
**建议**：`scope` 为空时给出区分化提示（如「本文档未识别到 Appendix 章节」），并在 `scopedPages` 里于 References 处强制 `active = false`。

### [M4] 代码扫描与 AI 生成共用 `session.readingBusy` 一把锁，互相当机

**文件**：`native/Sources/CBCTReading/CodeStore.swift:37`、`native/Sources/CBCTReading/Store.swift:721`
`scanRepository`/`generateCodeMapping` 与 `openReading`/`runAsk` 都用 `s.readingBusy` 做互斥。用户在「论文与代码」页扫描一个较大仓库期间，所有分层精读与 Chat 都被禁；反之亦然。语义上二者互不冲突。
**建议**：拆分 `codeBusy` 与 `readingBusy`，或至少给用户明确进度提示。

### [M5] `/api/reflect` 未落笔也先写 progress；审稿对话固定存到 `"null"` 键

**文件**：`app/server.js:231-238`（键选择）、`403-414`（先写后判）

```js
const key = arxiv || noteId;        // 231-238
const p = progress[key] = progress[key] || { step: 1 };
```
其余所有路径都用 `arxiv || id`（`queueKey` / `noteForQueue` / `computeToday`），而前端在队列条目上传的 `noteId` 常为 `null`（`app.js:211`、`:91` 的 `paper.noteId || ''`）。
**我的独立复现**：`arxiv='' , noteId=null` → `Object.keys(progress)` 得到 `["null"]`，即审稿记录落在字符串 `"null"` 下，步骤 ③ 读的是 `progress[p.key]`，**永远看不到它**。
另：`/api/reflect` 在 `appendAnnotation` 返回 `null`（没有匹配笔记）时仍然先创建并保存了 progress 条目 → 错误的 key 会污染日志并虚增连击。
**建议**：键改为 `arxiv || (note && note.key) || ''`，为空则不记录；先调 `appendAnnotation`，返回 `null` 时直接 `return json(res, 404, ...)` 不再写盘。

### [M6] `/api/ask` 不校验 `history`/`question` 类型，且把内部调用栈返回给客户端

**文件**：`app/server.js:181, 186, 189, 461`
**我的独立复现**：
```
POST /api/ask {"history":{"a":1}}
-> 500 {"error":"TypeError: history.slice is not a function\n at handleAsk (.../app/server.js:189:16)\n at route (...)"}
```
泄漏绝对路径与内部结构，且任何调用方都能触发（配合 [C4] 连 Origin 都不需要）。
**建议**：进入 `handleAsk` 后强制 `Array.isArray(history) ? history.filter(h => h && typeof h.t === 'string').slice(-8) : []`；`question` 非字符串则置 `''`；catch 分支只回 `{error:'internal_error'}`，栈只写服务端日志。

### [M7] 帮助占位符 `…` 被写进聊天历史，多轮对话丢失上文

**文件**：`app/public/app.js:70-77`（`addMsg`）、`84-86`（推入 `'…'`）、`105-111`（只改 DOM 不回写 `S.chat`）
**我的独立复现**：第 2 轮发给上游的历史为
```
[{"r":"user","t":"first question"},{"r":"ai","t":"…"},{"r":"user","t":"second question"}]
```
模型完全看不到上一轮回答，多轮「挑毛病」无法累积；却仍消耗了该空轮次的 token。
**建议**：把 `{r:'ai', t:''}` 推入 `S.chat` 并在流式过程中同步更新 `msg.t`；失败时 `S.chat.pop()` 两次回滚。

### [M8] `_template.md` 的行内 `#` 注释被当成字段值，新建笔记的 `key` 彻底错乱

**文件**：`app/server.js:46-64`（只跳过整行注释）、`papers/_template.md`（几乎每个字段都带行内注释）
**我的独立复现**（用真实模板跑真实解析逻辑）：
```
"id"    => "\"                    # 与文件名一致：YYYY-短名，如 2022-naf"
"title" => "\"                 # 原文标题"
"arxiv" => "\"                 # arXiv 编号，无则留空"
derived key => "\"                 # arXiv 编号，无则留空"
```
模板是 README 指定的新笔记起点，于是新论文的 progress key 变成一整串带注释的字符串，**任何正常 id 都找不到它**。原生端 `Store.parseFrontmatter` 同样不剥离行内注释（`Store.swift:290-314`），这是**两端共同**的缺陷。
**建议**：未加引号的值先 `v.replace(/\s+#.*$/, '')`；带引号的值截到闭合引号为止。

### [M9] 旧版数组格式 `queue.json` 在兜底版被静默丢弃

**文件**：`app/server.js:103-105`
**我的独立复现**：写入 `[{"arxiv":"2209.14540"}]` 后 `/api/state` 的 `queue length = 0`，无任何提示，首页「待读队列」整块消失。
`PRD-路线.md:46` 明确宣称兼容两种格式（「修复原队列静默加载为空」），原生端 `PaperIdentity.decodeQueue` 确实兼容（`ResearchModels.swift:94-99`）——**只有兜底版没做到**。
**建议**：`Array.isArray(raw) ? raw : raw.papers`，无法识别时写日志而非静默返回 `[]`。

### [M10] 请求体超限时 `req.destroy()`，既无响应也不结束 Promise

**文件**：`app/server.js:330-337`
**我的独立复现**：发送 6 MB JSON → `HTTP 100`、`size_download=0`，客户端拿着空响应，服务端仍存活。调用方无法区分「太大」和「服务端挂了」。
**建议**：改为 `reject(Object.assign(new Error('payload_too_large'), { status: 413 }))` 并让 `route` 把 `err.status` 映射为响应码；同时按**字节数**而非字符数统计上限。

### [M11] 出站请求没有超时，PDF 全量读入内存

**文件**：`app/server.js:142, 195, 272, 282`
所有 `fetch` 都没有 `AbortSignal.timeout`；`arxivCache`（139）永不淘汰；`fetchPdf` 用 `Buffer.from(await res.arrayBuffer())` 把 3–10 MB 的 PDF 整个读进内存。
**影响**：上游卡住时抽屉永远停在 `…` 且无法取消（此项为**基于代码的判断**，未构造上游 stall 复现；缺超时是确定的）。
**建议**：加 `AbortSignal.timeout(30_000)`（PDF 用 300_000），PDF 改为 `Readable.fromWeb(res.body).pipe(createWriteStream(...))` 流式落盘。

### [M12] `ReproductionPanel.onAppear` 会抢走当前 `readingKind`

**文件**：`native/Sources/CBCTReading/ReproductionViews.swift:57-61`
```swift
.onAppear {
    if session.readingKind != "reproduce", store.loadReadings(session.ref.key)?.reproductionJSON != nil {
        store.openReading(session, kind: "reproduce")
    }
}
```
Step4 的 `Picker` 只能在「笔记 / 迁移 / 复现」间切换，切到复现时 `onAppear` 会把正在显示的 apply 结果替换掉（`readingKind` 是全局单值）。原生 `阅读` 面板已用 `setStep(4)+notesMode` 处理，只有该 `onAppear` 是隐式副作用。
**建议**：去掉该 `onAppear`，或只在 `readingKind == nil` 时执行。

### [M13] `safeJoin` 使用字符串前缀判断，存在同前缀兄弟目录逃逸隐患

**文件**：`app/server.js:343-346`
```js
function safeJoin(base, urlPath) {
  const p = path.normalize(path.join(base, urlPath));
  return p.startsWith(base) ? p : null;
}
```
`/ROOT/library/../libraryX/secret` 归一化后为 `/ROOT/libraryX/secret`，它 `startsWith('/ROOT/library')` 为 **true**。目前仓库里不存在 `libraryX` 之类的同前缀目录，故**当前不可利用**，属潜在缺陷。
**建议**：
```diff
-  return p.startsWith(base) ? p : null;
+  const root = base.endsWith(path.sep) ? base : base + path.sep;
+  return (p === base || p.startsWith(root)) ? p : null;
```

### [M14] `/api/pdf/<id>` 解码而 `/api/fetchpdf/<id>` 不解码，行为不对称

**文件**：`app/server.js:419`（`decodeURIComponent`）与 `app/server.js:426`（直接用 `p.split('/')[3]`）
好消息：我逐一验证过，**目前没有可利用的路径穿越**——`/api/pdf` 经 `readdirSync` 白名单匹配现有 PDF 文件名；`/api/fetchpdf` 不解码，`%2F` 不会被还原成 `/`，`path.join` 只会产生含字面 `%2F` 的文件名。另 `findLocalPdf` 的 `path.join(LIB_DIR, f)` 对读取是受限的。
**建议**：统一解码并显式校验 key（`^[A-Za-z0-9._-]+$`）。

### [M15] 原生端与兜底端温度参数不一致

`native/Sources/CBCTReading/AIService.swift:114` → `temperature: 0.2`
`app/server.js:198` → `temperature: 0.6`
同一产品两条路径生成风格不同，且都没有 `seed`，同一篇论文两次生成不可复现。审计记录只保存 `model` 字符串，不含权重版本（`REPORT.md:3` 自认）。
**建议**：把 `temperature` 收进 `Config`，两条路径读同一值；审计里记录 `temperature` 与 `baseURL`。

### [M16] 非 200 响应体被读入后丢弃

**文件**：`native/Sources/CBCTReading/AIService.swift:121-125`
```swift
if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
    var text = ""
    for try await l in bytes.lines { text += l }     // 读了，但没用
    onError("接口返回 \(http.statusCode)，请检查 API 地址、模型与访问权限。")
    return
}
```
丢弃了服务端的具体错误（如 `model not found` / 额度不足），排障成本高。JS 版会把 `detail.slice(0,500)` 返回给前端（`server.js:201-204`）。
**建议**：把 `text`（截断后）拼进错误信息，但要先过滤可能回显的 key。

### [M17] `Markdown.parse` 中 `.heading` 分支不可达（死代码）

**文件**：`native/Sources/CBCTReading/Markdown.swift:18-29`
`kind` 只会被赋为 `.quote/.bullets/.ordered/.paragraph`（第 38/42/47/50 行），标题在 34–36 行直接 `blocks.append`，因此 `flush()` 里的 `case .heading(let t, let l)` 永远不执行。
**建议**：删除该 case（纯清理，不影响行为）。

### [M18] `PDFLayout.rows` 按 1 像素步长做整页选择查询

**文件**：`native/Sources/CBCTReading/PDFLayout.swift:12-16`
`for y in stride(from: bounds.maxY, through: bounds.minY, by: -1)` → 每页约 792 次 `page.selection(for:)`。
**实测**：单页 2 ms、目标表页共 2 页、整篇 `page.string` 仅 42 ms → 可接受，**不构成性能问题**（我原本怀疑是热点，实测证伪）。仅作提醒：`text(_:)` 对每页跑一次 `table N` 正则 + 可能的 rows()，若未来对 100+ 页论文频繁调用可加缓存。
**建议**：保持现状，或在 `ensurePDFText` 层面缓存已是现状（`-v3.txt`）。无需修改。

### [M19] `SelecableTextView` 可能触发反复布局

**文件**：`native/Sources/CBCTReading/NativeViews.swift:35-44`（`layout()` 内改 `frame.size`）、`:119-128`（`updateNSView` 用 `attributedString() != attributed` 做全量字符串比较）
`layout()` 中途改自身 frame 有布局循环风险；大文本每次更新都做 NSAttributedString 深比较。
**建议**：把宽度/高度调整放到 `DispatchQueue.main.async`，并用内容 hash 替代全量比较。

### [M20] 对同一篇论文重复下载 PDF 的窗口

**文件**：`native/Sources/CBCTReading/Store.swift:450-457`
```swift
if let existing = pdfDownloads[ref.key] { return try await existing.value }
let task = Task { try await self.downloadPDF(for: ref) }
pdfDownloads[ref.key] = task
defer { pdfDownloads[ref.key] = nil }     // 第一个 awaiter 返回即清除
```
在任务完成与本函数返回之间到达的第二次调用会**重新下载**；`downloadPDF` 里 `try? removeItem(at: dst)` 又会删掉另一路刚写好的文件（`:479`）。
**建议**：改为只在任务真正结束时清除（在 `Task` 内 `defer`），并去掉 `removeItem(at: dst)`（`moveItem` 覆盖失败时再处理）。

### [M21] `Evidence.numbers` 从标识符里抠数字（真实缺陷，但原始表述需更正）

> **更正说明（2026-10-02，第二轮复核）**：本报告初版称「`results-v2` 被误拒」。**该结论错误，特此更正。**
> 复核后确认：`results-v2` 被拒的**主因是真实证据缺口**——它的 `header.excerpt` 只包含了 FDK 一行，
> 而 `header.v` 里写了 `ASD-POCS [20]`、`IntraTomo3D [28]`，`20` 与 `28` 确实不在摘录中。
> 校验器拒绝它是**正确行为**。请勿按初版描述去「修」这个拒绝。
> 本条缺陷本身**成立**，但性质是「诊断信息被污染 + 反向漏检」，不是「误杀正确输出」。

**文件**：`native/Sources/CBCTReading/ResearchModels.swift:220-227`

**当前代码**：
```swift
let regex = try! NSRegularExpression(pattern: "[+-]?(?:[0-9]*\\.[0-9]+|[0-9]+)")
return Set(regex.matches(...).compactMap { ... })
```
正则不带词边界，方法名里的数字会被当成测量值。实测（编译真实 `Evidence.numbers`）：

```
IntraTomo3D -> ["3"]        ASD-POCS -> []        NAF (Ours) -> []
128×128×128 -> ["128"]      RTX 3090 -> ["3090"]  five datasets -> ["5"]
```

**成立的两个后果**：

**(1) 诊断信息被污染（已发生，但不改变判定结果）**：`results-v2` 的拒绝理由原文是
`「…IntraTomo3D [2」的数字 20, 28, 3 未被所附摘录支持`。其中 `20`/`28` 是真实缺口，
但 `3` 是从 `IntraTomo3D` 里抠出来的**伪缺口**。这会让模型在自动修正时去追一个不存在的问题，
浪费一次修正机会（该机制最多自动修正 2 次）。**判定仍正确，只是理由不精确。**

**(2) 反向漏检（真缺陷，可构造并已复现）**：若摘录本身包含 `IntraTomo3D`（正常情况，例如
`"IntraTomo3D [28] 31.94/.95"`），则伪造的测量值会因数字重合而通过：
```
摘录 = "IntraTomo3D [28] 31.94/.95"
  claim "IntraTomo3D reaches 3 dB"   -> unsupported=[]  ★通过（伪造成立）
  claim "IntraTomo3D uses 3 views"   -> unsupported=[]  ★通过
  claim "3D method uses 3 views"     -> unsupported=[]  ★通过
```
即：只要伪造值碰巧等于某个标识符里的数字，数字子集校验就放行。

**建议修改**（已验证：对现有全部真实记法无副作用）
```diff
-    let regex = try! NSRegularExpression(pattern: "[+-]?(?:[0-9]*\\.[0-9]+|[0-9]+)")
-    return Set(regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { ... })
+    let regex = try! NSRegularExpression(pattern: "[+-]?(?:[0-9]*\\.[0-9]+|[0-9]+)")
+    let ns = text as NSString
+    let scalars = Array(text.unicodeScalars)
+    func isLetter(_ i: Int) -> Bool {
+        i >= 0 && i < scalars.count && CharacterSet.letters.contains(scalars[i])
+    }
+    // 只排除「完全嵌在单词中间」的数字 token（IntraTomo3D -> 3）。
+    // 刻意保留贴在单词后的型号数字（RTX3090 -> 3090、1.2GB -> 1.2），它们是真实报告的事实。
+    return Set(regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m -> String? in
+        if isLetter(m.range.location - 1) && isLetter(m.range.location + m.range.length) { return nil }
+        return ns.substring(with: m.range)
+    })
```

**副作用验证（23 个真实记法，全部保持原值 + 4 个标识符清空）**：
```
保持不变的（old == new）：.958 / 0.958 / 22.89/.78 / 128 / 128×128×128 / RTX 3090 /
  1×10−3 / FDK [7] / 33.05/.96 / 5 datasets / five datasets / single RTX 3090 /
  512×512×510 / 24 GB / 1e-3 / 3.07 dB / 50 projections / 1.2GB / RTX3090 /
  192 points / 3% noise / 1.2 / 10-40 minutes      -> 23/23 OK
被清空的：IntraTomo3D -> []   ASD-POCS -> []   NAF (Ours) -> []
（"3D" 仍为 ["3"]：单独出现时它更像型号，保留是安全的）
现有测试断言仍成立：numbers("34.45/.95 30.34/.88") == [.88,.95,30.34,34.45]；
  numbers("five datasets, single RTX 3090") == [1,3090,5]；1×10^3 ⊄ 1×10−3
```
**注意**：不能用 `(?<![\p{L}_])...(?![\p{L}_])` 这种双侧边界——实测它会破坏
`1.2GB -> 1`、`RTX3090 -> 090`，属于更差的修法。

**补充建议**：`caption`/`header`/`protocol` 等元数据字段本不该做数字子集校验（prompt 已要求
`header.v` 直接复制 `header.excerpt`）。但经复核，**这一条不建议现在改**——`results-v2` 的正确拒绝
正是靠它拦住的（真实缺口 `20`/`28`）。若将来要豁免，必须另加「摘录须覆盖全部方法行」的检查来补偿。

**回归测试**：`XCTAssertEqual(Evidence.numbers("IntraTomo3D"), [])`；
`XCTAssertEqual(Evidence.numbers("RTX3090"), ["3090"])`；`XCTAssertEqual(Evidence.numbers("1.2GB"), ["1.2"])`。

### [M22] 指标可信度复核：25 组 PSNR/SSIM 与源码 PDF 逐格一致（PASS）

这是你清单「十八、科研代码额外审查 → 指标可信度」的独立验证，**结论是正面**的，记录在此以备核对。

**来源**：`library/2022-NAF-2209.14540.pdf` 第 7 页 Table 2（用真实 `PDFLayout.text` 抽取，**非**转抄验收报告）。

**核验 1 — 笔记 `papers/2022-naf.md` 的 NAF 行**：Chest 33.05/.96、Jaw 34.14/.94、Foot 31.63/.94、Abdomen 34.45/.95、Aorta 30.34/.88 → **5/5 与 PDF 一致**；正文「abdomen 比第二名高 3.07 dB」经计算 `34.45 − 31.38 = 3.07` ✓。

**核验 2 — 三份结果抽取产物逐格比对 PDF 全表（5 方法 × 5 数据集 × 2 指标 = 50 格）**：
```
results-v1: 50 ok / 0 bad   | 判定: structural validation passed
results-v2: 50 ok / 0 bad   | 判定: failed（假失败，见 M21 方向 A）
results-v3: 50 ok / 0 bad   | 判定: structural validation passed
```
即**所有 150 个抽取值全部正确**，包括被拒的 v2。Table 1 的设置（50 views、TIGRE 3% 噪声、180°、各器官探测器分辨率、Aorta 582 取 50、500×500、−103°–93°、Adam 1e-3→1e-4、batch 2048 rays、单张 RTX 3090、`192 points @ 128³`）我也在 PDF 第 6 页逐条读到，与笔记 frontmatter 一致。

**但发现笔记里一处措辞过度**：`papers/2022-naf.md` 写「abdomen 上比第二名 SART 高 3.07 dB」。PDF 原文只说 "second-best method SART"（仅针对 abdomen）。而按 Table 2 实际排序，第二名在各数据集上并不都是 SART：
```
Chest   1st=NAF 2nd=SART         ✓ 笔记措辞成立
Jaw     1st=NAF 2nd=ASD-POCS     ✗
Foot    1st=NAF 2nd=IntraTomo3D  ✗
Abdomen 1st=NAF 2nd=SART         ✓
Aorta   1st=NAF 2nd=IntraTomo3D  ✗
```
笔记那句话本身限定在 abdomen，**没有错**；但若后续有人把「3.07 dB 领先 SART」外推成「全面领先 SART」就会失真。建议在笔记里补一句范围限定（「仅 abdomen 的第二名是 SART」），避免跨论文比较时误用。

**核验 3 — 样本量（清单要求必须报告）**：
```
实际测试样本数量：1 篇论文（NAF，11 页），15 次运行 / 35 条模块记录
预期测试样本数量：无独立测试集概念；PRD 建议指标（≥90% 引用追溯、≥70% 推荐相关）需多论文评测
无法由现有代码确定：跨论文的抽取质量、引用覆盖率 → 应增加 assertion（见 M23）
```
**结论**：在「单篇 NAF 的主结果表」这个范围内，**表格数字完全可信**（150/150 与 PDF 一致，我独立复核）。但「单篇样本」不能支撑任何总体正确率声明。

### [M23] 断言缺失清单（建议增加）

按价值排序：
1. `Store.appendAnnotation` 后用 `splitSections` 断言「annotations 只被解析出一个非空值，且原批注仍在」——当前无任何测试覆盖 `appendAnnotation`。
2. `ResultsAnalysis.validate` 增加行内数字顺序断言（见 C2）。
3. `Store.ensurePDFText` 的可用性门槛（`Store.swift:689`）目前是「全文档总字符 > 200」，极易被目录页/版权页蒙混；改为**至少 1 页**的正文长度阈值。
4. `Store.loadNotes` 后断言 `notes.count == 文件数`，防「读取失败静默 continue」（`Store.swift:281-286` 对读取失败的文件是 `continue`，无任何提示 → 论文会无声消失）。
5. `refreshDiscovery` 断言 `discovery.papers.count` 与 `successes` 的对应关系，防止两个源都失败时把旧缓存写回却标记为新抓取。
6. `RepositoryService.scan` 保留现有 `guard !files.isEmpty`，建议再加 `files.count == entries.count` 断言（当前只检查非空，缓存命中路径 `:77-82` 若 `cached.files` 找不到会走网络，逻辑正确但缺断言）。

### [M24] 其它 Low（工程/规范，不影响结果）

- `Store.swift:342` `noteForQueue` 用 `$0.file.lowercased().contains(q.key.lowercased())` 做文件名子串匹配，短 key（如手工条目 `manual`、`intratomo-2021`）可能误配到别的笔记文件。
- `Store.swift:447` `findLibraryPDF` 同样用 `contains(key)`，不同 arXiv 号互为子串时会取错 PDF。
- `Store.swift:474` 只读前 4 字节判断 `%PDF`；`:689` 的可用性阈值偏低（见 M23 第 3 条）。
- `DiscoveryService.swift:34` `didEndElement` 直接 `_ = stack.popLast()`，不校验标签名，遇到畸形 XML 会静默错位（低风险）。
- `ResearchModels.swift:220-227` `Evidence.numbers` 把 `single→1`、`one→1`，会造成 v/excerpt 数字比对出现偶然等价（例如 "single GPU" 与 "1 GPU" 互认），方向偏宽松。
- `Store.swift:876` `stepQuestions` 的 `drop(while: { $0 == "-" || $0 == " " })` 只剥离开头连续的 `-`/空格，混杂缩进的批注 bullet 可能带上残留符号。
- `Store.swift:640` `finishReading` 的 `composed` 若含换行，会被拼成 `- （日期·精读室）多行内容`，破坏 Markdown 列表缩进。
- `Views.swift:49-72` `dumpLayoutHierarchy()` 是调试自检函数，正式路径仍在 `Step2View.onAppear`（`Views.swift:387-390`）触发写 `native/layout.log`；建议加 `#if DEBUG`。
- `native/build-app.sh` 使用 `codesign --force -s -`（ad-hoc），无 hardened runtime / sandbox / 公证；`app/config.json` 含明文 API Key，已确认**未被提交**（`.gitignore:2`），但应用本身不加密存储。
- `app/server.js:395` `if (body.step)` 对 `step=0` 静默忽略，与原生端 `max($0.step ?? 0, n)` 语义不同（两端不一致，影响很小）。
- `app/server.js:104` `loadQueue()` 只支持 `{papers:[...]}`，而原生端 `PaperIdentity.decodeQueue` 兼容裸数组（`ResearchModels.swift:94-99`）；旧数组格式队列在兜底版会**静默变成空队列**。

### [M25] 验收样本并非来自同一次运行：每个「通过」的模块都取自不同 run，且没有任何一次运行端到端全绿
**文件**：`native/acceptance/2026-10-02/*/NAF-run.json`（15 次真实模型运行的机器可读记录）+ `REPORT.md:16-25` 的「本轮采用的输出」表

**问题**：我解析了全部 15 个 run 文件，得到「模块 × 运行」矩阵（P=通过结构校验，F=被校验器拒绝，`.`=该轮未跑）：

```
                     apply-v3  code-v1  code-v2  code-v3     final layout-v3 release-v3  rep-v1  rep-v2  rep-v3  rep-v4 results-v1 results-v2 results-v3 verified-v3
apply                       P        .        .        .         F         F          F       .       .       .       .          .          .          .           F
experiment                  .        .        .        .         F         F          P       .       .       .       .          .          .          .           F
reproduce                   .        .        .        .         .         .          .       F       F       P       P          .          .          .           .
results                     .        .        .        .         .         .          .       .       .       .       .          P          F          P           .
```
`REPORT.md` 的采纳表显示的正是**跨 run 挑选**：
| 模块 | 采纳 run | 该模块历史通过率 |
|---|---|---|
| 实验抽取 | `release-v3` | **1/4** |
| 迁移建议 | `apply-v3` | **1/5** |
| 复现 | `reproduction-v4` | 2/4 |
| 结果 | `results-v3` | 2/3 |

并且**没有任何一次运行让全部模块同时通过**（`verified-v3` 跑了 8 个模块，`experiment`/`apply` 仍失败）。逐模块统计：`apply` 20%、`experiment` 25%、`reproduce` 50%、`results` 67%，总计 **25 pass / 10 fail = 71%**。

**为什么重要**：这**不是**代码缺陷——它恰恰说明校验器在工作（真正的拒绝记录都保留着，没有删失败样本，`REPRODUCTION.md:30` 明确写「失败样本仍保留」）。但从「实验结果可信度」角度必须指出：
- 对外呈现的「8 个模块全部通过」是**15 次运行结果的并集**，不是任何一次真实端到端运行的产物；
- 若把「抽取质量」当作一个要报告的比率，诚实的分母是 **35 次尝试中的 10 次失败（29% 拒绝率）**，而不是「全通过」；
- `experiment` 与 `apply` 各只有 1 次通过，属于**最弱环节**，而它们正是 `PRD-验收矩阵` 里 P0 的实验抽取项。

**建议**：在 `REPORT.md` / `REPRODUCTION.md` 顶部直接给出这张矩阵与按模块的通过率（数据已在 run 文件里，无需重跑），并明确写出「单次运行端到端通过率 = 0/15」，避免读者把并集误读成稳定性。也可让 `ModelAcceptance.swift` 在收尾时自动汇总各 run 的 pass/fail 统计写进 `NAF-run.json` 之外的总表。

### [M26] 文档中的回归测试数量与实际不符（4 处）

**文件**：`README.md:64`（27 项）、`PRD-路线.md:35`（18 项）、`:74`（24 项）、`:82`（27 项）、`native/acceptance/2026-10-02/REPORT.md:7`（24 项）、`REPRODUCTION.md:15`（27 项）

**实测**：`ResearchTests.swift` 的 `cases` 数组注册 **33** 个，运行输出 **`32 passed; 0 failed`** + 1 个 `SKIP`（`CBCT_LIVE_TESTS=1` 才跑）。`REPORT.md` 与 `REPRODUCTION.md` 是**同一天**的两份验收报告，一个写 24、一个写 27。

**影响**：属于可复现性陈述失真——读者无法从文档确认到底跑了多少项。`PRD-路线.md:35` 的 18 项更是明显过期。
**建议**：改为引用实际输出（或让 `test.sh` 把 `\(passes) passed` 写入报告）。

### [M27] 导出 schema 版本号与文档不一致

**文件**：`native/Sources/CBCTReading/ResearchStore.swift:141` `var schemaVersion = "1.4"` vs `PRD-路线.md:82`「资产导出 schema 更新到 1.3」

**影响**：低（仅文档滞后），但会让「导出的 JSON 是哪一版 schema」无法从文档判断；当前 `Export` 结构里 `schemaVersion` 是**恒为 "1.4" 的常量**，没有随字段变化联动。
**建议**：更新 `PRD-路线.md:82` 为 1.4，或在 `Export` 上加注释说明 1.3→1.4 增加了 `reproduction`/`code` 字段。

### [M28] `app/public/style.css` 缺少 `.selectable` 与 `.date` 两条规则

**文件**：`app/public/style.css`（171 行）
我枚举了 JS/DOM 实际用到的 40 个 class，只有两个没有对应样式规则：`.selectable`（`app.js:123/134` 用它判断能否弹出「这里没懂」浮标，`:296/312-314/359/360` 用它包裹可选中正文）与 `.date`（`index.html:20` 的日期显示）。二者是**功能性选择器**，缺样式不影响逻辑，仅缺视觉提示（可选中区域无边框/背景，用户不知道哪里能选）。
**建议**：给 `.selectable` 加轻微视觉提示（如左侧细线或浅底），或明确这是有意为之。

### [M29] `native/make-icon.swift` 与 `app/package.json` 复核结论（无缺陷）

- `make-icon.swift`：`try?` 静默失败（`build-app.sh` 有 `[ -f AppIcon.icns ]` 缓存判断，不会重复生成）；图标已存在，实际不会再跑。无影响。
- `app/package.json`：`devDependencies.electron ^44.5.1` 是真实发布版本，`scripts.start`/`web` 与 `electron-main.js`、`server.js` 入口一致。无缺陷。
- `app/public/index.html`：JS 在加载时查询的全部 id（`view/streak/todayDate/configBtn/configClose/configMask/drawer/drawerMode/drawerMsgs/drawerForm/drawerInput/drawerClose/selPill/toast`）都存在。仅缺 CSP（见 H5 建议）与 L6 的过期文案。

---

## E. 数据流与形状/范围检查结果

本项目没有 tensor。等价的数据流如下（实测值来自真实仓库数据）：

```
原始数据
  papers/*.md (frontmatter + ## 小节)          1 篇
  queue.json  {papers:[...]}                   3 条
  library/*.pdf (11 页 NAF)                    PDFKit
  app/data/discovery.json                      40 篇（arXiv+PubMed，1 个源报错 "PubMed：cancelled"）
        ↓ Store.loadNotes / decodeQueue / loadResearchData
内存模型
  notes: [Note]            meta:[String:MetaValue], sections:[String:String]
  queue: [QueueEntry]      key = arxiv(vN 已剥离) ?? id
  libraryState: [String:LibraryState]  status ∈ {unread,later,reading,read,ignored}
        ↓ (视图触发计算属性，见 H2)
  allPapers = deduplicate(queue + notes + discovery)      ← 40 篇量级时 19.7 ms/次
        ↓
模型输入（外部 LLM，不是本地网络）
  AIService.systemPrompt = 笔记上下文 + 规则 8 条
  + "\n\n【论文全文（按页标记）】" + Evidence.select(pdfText, ...)
  实测 全文 26,670 字符；Method 13,608；Experiment 2,503；Appendix 0；Figure 1,558
  单次请求上限 Evidence.select limit = 50,000 字符
  temperature 0.2（原生）/ 0.6（兜底）
        ↓ 流式 SSE
输出（文本）
  分层精读 → Markdown（要求 (Page N)）
  experiment/apply/reproduce/results → JSON
        ↓ 校验（等价于「loss 是否真的约束住输出」）
  Evidence.normalized(quote) ∈ normalized(pageText)     ← 归一化后逐字匹配（连字符/连字/全角）
  Evidence.numbers(v) ⊆ Evidence.numbers(excerpt)        ← 数字子集，集合语义
  Evidence.citations(out) ⊆ pages(source)                ← 页码子集
        ↓ 落盘
  app/data/readings/<key>.json   (历史归档 readings/history/<key>-<uuid>.json)
  app/data/library.json / progress.json / ideas.json
  app/data/reproduction/<key>.json  (按 fingerprint 分版本)
  app/data/code/<key>.json
        ↓ 展示
  差值 Δ = a - b 由程序算（ResultModels.swift:100-106），相对百分比在 unit=dB/PSNR 或 b=0 时禁用
```
**范围一致性结论**：三处证据链共用同一份 `ensurePDFText` 缓存（`library/text/<key>-v3.txt`），训练/生成/校验/展示**没有**出现「两次不同归一化」的问题——这一点是干净的。真正的缺口在于**校验的表达力不足**（C2）与**回写路径的正则错误**（C1）。

---

## F. 「模型 Shape 表」→ 实际数据结构表（替代）

| 结构 | 输入 | 输出 | 关键约束 |
|---|---|---|---|
| `PaperIdentity.deduplicate` | `[QueueEntry]` | `[QueueEntry]` | O(n²)；key/DOI/标题+作者 |
| `PaperIdentity.rank` | `QueueEntry`+`ResearchProfile`+`LibraryState` | `RankedPaper(score 0…100)` | 规则评分，非模型置信度 |
| `Evidence.select` | 全文(pages 标记) | ≤50,000 字符的分页子集 | 保序、保留原页码 |
| `Evidence.pages` | 带 `=== Page N ===` 的文本 | `[EvidencePage]` | 正则 `try!`（无失败路径） |
| `ExperimentExtraction.validate` | JSON + source | throws | 摘录 ⊆ 页、v 的数字 ⊆ 摘录 |
| `ResultsAnalysis.validate` | JSON + source | throws | **无行列顺序校验（C2）** |
| `ReproductionAnalysis.fingerprint` | 结构 | SHA256 | 分析改版即换核对清单 |
| `CodeMappingAnalysis.validate` | JSON + `CodeSnapshot` | throws | 行号范围 + 逐字代码摘录 + symbol 存在 |
| `PDFLayout.rows` | `PDFPage` | `[Row(text,rect)]` | 792 次选择查询/页，实测 2 ms |

---

## G. 一致性检查（PASS / FAIL）

```
PDF 文本缓存一致性        PASS   三处共用 library/text/<key>-v3.txt
摘录归一化一致性          PASS   normalized() 同一实现用于校验与高亮定位
页码一致性                PASS   物理页统一 1-based，PDFKit index +1（NativeViews.swift:206）
数字证据一致性            PASS   集合语义，且保留原记法（.958 不被改写成 0.958）
单位来源一致性            PASS   单位必须出现在 context/unitEvidence 摘录中（ResultModels.swift:69-71）
表格行列一致性            FAIL   C2：列置换可通过全部校验（实测）
数字证据一致性(标识符)     FAIL   M21：IntraTomo3D 被抠出 "3"，导致 results-v2 假失败；反向可放过 "3 dB"
指标可信度(单篇主表)      PASS   M22：150/150 格与 PDF Table 2 逐格一致（独立复核）
批注回写一致性            FAIL   C1（Swift 正则）+ H4（JS 替换模式）→ 重复小节 / 旧批注被覆盖 / $ 展开
写盘原子性                FAIL   H9：兜底版原地写 + 静默吞错，原生版 .atomic ✓（两端不对称）
输入键安全                FAIL   C3：__proto__ 污染；H6/M5 的 key 派生错误
请求来源校验              FAIL   C4：无 Origin/Sec-Fetch-Site 校验，接受 text/plain
两端一致性                FAIL   temperature 0.2 vs 0.6；queue 数组格式仅原生端兼容；
                                frontmatter 行内注释仅两端都不处理；原子写仅原生端有
文档一致性                FAIL   M26：README/PRD 写 27/18/24 项，实际 33 case / 32 pass
验收样本一致性            FAIL   M25：8 个采纳模块来自 15 次不同运行；无一次端到端全绿；
                                按模块通过率 apply 20% / experiment 25% / reproduce 50% / results 67%
```

---

## H. 最值得优先修复的 5 个问题（只按对结果正确性的影响排序）

1. **[C2]** 结果表行列错配无校验 → PSNR/SSIM 表和差值可能是错的，而这正是产品的核心卖点。修复量约 8 行 + 1 条测试。（这是**唯一直接污染科研结论**的问题）
2. **[M21]** 数字校验从标识符抠数字 → **真实运行中已造成一次假失败**（results-v2 的 50 格全对却被拒），同时放过「3 dB」这类伪造。修正则 1 行 + 元数据字段豁免。
3. **[C4]** CSRF → 任意网页可写入你的研究笔记，而笔记会被送进 AI 提示词。修复量约 10 行。
4. **[C3]** `__proto__` 污染 → 全部论文被静默标记已读、连击与今日论文错乱。修复量约 12 行。
5. **[C1]** Swift 批注正则（1 行）+ **[H4]** JS `$` 替换模式（1 行）→ 用户笔记被重复写入且旧批注在应用内消失。
   （**[H9]** 非原子写 + 静默吞错紧随其后：一次损坏即丢失全部阅读历史，约 10 行。）

（紧随其后：**H8** `sendFile` 让整个进程退出、**H7** 无 `library/` 时 500，二者都是 1–3 行即可修，且当前就会触发。**H2/H3** 是性能项，排在其后。）

> **第二轮复核更正**：`results-v2` 被拒 **不是**误杀，其 `header.excerpt` 只含 FDK 一行，`[20]`/`[28]` 确为真实缺口。
> 初版把它写成「误拒」有误，已在 [M21] 条内标注更正。因此 **C2 与 M21 的修复都不会改变 v2 的（正确）拒绝结果**。

**若目标还包括「对外报告可信度」，则 [M25] 必须优先处理**：它不修代码，但决定了你能否说「8 个模块全部通过」。数据已在 `native/acceptance/2026-10-02/*/NAF-run.json` 里，只需把矩阵与 71% 通过率（25/35）写进验收报告。

---

## I. 修改建议（可直接采用的 diff）

见 C1 / C2 / C3 / C4 / H1 / H2 / H3 / H4 / H5 / H6 / H7 / H8 / H9 各条内联 diff。所有 diff 都遵守最小改动原则：
- 不改任何提示词（prompt）；
- 不改任何校验阈值（除新增的行内顺序检查）；
- 不改数据划分、文件格式、schema 版本；
- 不改网络结构与 UI 布局。

唯一需要你决策的是 C2 的顺序校验严格程度：**严格版**（要求单元格值在行摘录中严格按出现顺序）能拦住转置，但对「同一数字在行内出现多次」或「模型改了数字顺序但语义正确」的输入可能误拒。**保守版**是把顺序校验降级为「告警而非拒绝」，在 UI 上标出「疑似列错位，请核对 PDF」。我建议先用严格版 + 自动修正重试（现有 `repairAttempt < 2` 机制可直接复用），收集几次真实输出后再决定是否放宽。

## J. 最终风险评级

**Level 2（偏 Level 3 边缘）：存在较严重问题，建议修复后再依赖其输出。**

评级依据：
- 未达到 Level 3：校验器本身**有效**——32 项回归覆盖了摘录伪造、页码伪造、跨页拼接、数字不支持等场景，实测确实拦得住（换方法的数字、错误页码、编造摘录都被拒）。没有发现「凭空编造数据」的路径；C2 是**漏检**而非主动写入错误值。
- 高于 Level 1，理由有五条且全部经可执行复现：
  1. **C1 + H4** 使「我的批注」这条用户研究资产链在两个端各自损坏，且是静默的；
  2. **C2** 使「结构校验通过」这一 UI 背书**不等于**表格行列正确，而验收报告 `REPORT.md:45` 明确记录过该错误真实发生过——它直接决定 PSNR/SSIM 表能否被引用；
  3. **C3/C4** 让**任何**打开的网页都能把你的论文标记为已读、把任意文本写进你的笔记；笔记随后进入 AI 提示词。这不是理论风险，我用真实 HTTP 请求打穿了；
  4. **H6/H8** 说明兜底版目前处理的是当前仓库里就存在的输入（IntraTomo 手工条目、缺失的 `library/`），一个坏文件能让进程直接退出；
  5. **[M21]** 数字校验器从标识符抠数字（`IntraTomo3D`→`3`），会污染自动修正时的诊断理由，并给「伪造值恰好等于标识符数字」留出放行缝隙——它既不能保证通过的一定对（见 [C2]），也不能保证给出的失败理由都精确。
- 修复 C1+H4（2 行）、C2（约 8 行 + 1 条测试）、M21（约 4 行 + 2 条测试）、C3/C4（约 22 行）、H7/H8（约 6 行）后，配合现有 32 项回归，可升至 **Level 1**；只有在完成跨多篇论文的抽取质量评测（**当前真实模型样本数 = 1**）并记录引用追溯率之后，才谈得上 Level 0。

---

### 附：本次审查用到的可复现验证命令

```bash
# 基线
./native/test.sh                                  # 32 passed; 0 failed; 1 skipped

# ---- 全部在 /tmp 的投递副本上执行，未改动仓库任何文件 ----
# C1：Swift 正则复现（编译真实逻辑跑 papers/2022-naf.md）
#   -> "SWIFT regex DID NOT MATCH"; 生成 2 个 '## 5. 我的批注'
# C2：转置复现（真实 ResultsAnalysis.validate）
#   -> correct: PASSED / transposed: PASSED / 换方法的数字: REJECTED
# C3：真实 HTTP 请求
#   -> POST /api/progress/__proto__ {"step":9,"done":true} => 每篇 done:true, step:9
# C4：真实 HTTP 请求
#   -> POST /api/reflect/2209.14540 (Origin: https://evil.example, Content-Type: text/plain)
#      => {"ok":true,"writtenTo":"2022-naf"}，笔记被写入
# H2：去重耗时（真实 app/data/discovery.json，40 篇）
#   -> 19.673 ms per deduplicate() call
# M3：scope 覆盖（真实 11 页 NAF PDF）
#   -> 全文 26670 / Method 13608 / Experiment 2503 / Appendix 0 / Figure 1558
# H1：属性注入
#   -> <div class="selectable" data-ctx="Sparse-view CBCT " onmouseover="alert(1)" x="">
# H4：Node 复现 -> "- （…·精读室）价格是 ## 5. 我的批注 而 ## 5. 我的批注 也特殊"
# H5：Node 复现 -> <a href="https://a.com"onmouseover="alert(1" …>click</a>
# H6：Node 复现 -> data-q="" -> find() undefined -> TypeError
# H7：curl -> HTTP 500 + ENOENT 调用栈
# H8：curl /noread.js -> HTTP 000，node 进程退出
# H9：写坏 progress.json 后一次 POST -> 文件被覆盖为 {"k9":{...}}，历史丢失
# M1/M2/M3/M5/M6/M7/M8/M9/M10/M11/M13/M15（Medium 级）均已用 Node/curl 独立复现，输出见各条正文
# M22：用真实 PDFLayout.text 抽 PDF p7 Table 2，逐格比对 3 份产物
#    -> results-v1/v2/v3 各 50 格全部与原文一致（150/150）；v2 被拒是因为表头摘录缺口（正确）
# M25：解析 native/acceptance/2026-10-02/*/NAF-run.json（15 run / 35 record）
#    -> 模块通过率 apply 20% experiment 25% reproduce 50% results 67%；总计 25P/10F；无 run 全绿
```

**覆盖范围**：仓库全部文本源码与配置已逐文件阅读（`native/Sources/CBCTReading/` 22 个 Swift、`native/Tests/` 5 个、`app/` 全部源码与 JSON、`native/*.sh`、根目录 MD/JSON、`papers/`、`library/text/`、`native/acceptance/` 全部产物）。二进制资产（`.icns`/`.png`/`.pdf`）与 `native/.build/` 编译产物按设计跳过。

**审查方法说明**：本报告中的每一项都被我独立执行验证过（Node/Python/Swift 编译真实源码、对 `/tmp` 下的服务副本发真实 HTTP 请求）。少数仅凭代码推断、未能构造复现的项已明确标注为 `suspected`。**审查阶段未修改任何源文件**；修复阶段的改动与验证见文末「修复记录」。

---

# 修复记录（2026-10-02 第二轮实测）

本轮按最小修改原则修复。**未改动**任何 prompt、校验阈值、schema、网络结构、UI 布局、数据划分。
验证基线：`native/test.sh` **37 passed / 0 failed / 1 skipped**（修复前 35 passed）；`node --check` 两个 JS 文件通过。

## 已修复并逐项验证

| 编号 | 缺陷 | 修改 | 验证方式与结果 |
|---|---|---|---|
| **C1** | 批注正则缺 `.anchorsMatchLines` → 重复小节 + 旧批注被覆盖 | `Store.annotatedNote` 改用 `(?m)` 行锚定 | 既有回归 `Annotation append / no duplicate section` PASS |
| **C2** | 结果表列置换可整体通过校验 | `ResultModels.validate` 增加**按表头列顺序**的位置校验 | 新测试 `Results column transposition rejected` PASS；**用真实 v1/v2/v3 产物重放：15 行 150 格顺序违规 = 0**，v1/v3 仍 PASS、v2 仍因真实证据缺口被拒 |
| **C3** | `progress['__proto__']` 污染原型 | `safeKey` / `parseBody` reviver / `upsertProgress` 用 `hasOwnProperty` | 活体：`POST /api/progress/__proto__` → **400 `bad_key`**；`/api/state` 各论文 `done:false`（修复前全部 `done:true, step:9`） |
| **C4** | 无来源校验 → 任意网页可写笔记 | `sameOrigin()` 校验 `Origin` + `Sec-Fetch-Site`，所有非 GET 请求前置拦截 | 活体：外源 `text/plain` → **403**，笔记未被写入；同源无 Origin → 200 正常写入 |
| **H1** | `esc()` 未转义引号 → 属性注入 | `esc` 增加 `"` `'` 转义 | 真实笔记 `data-ctx` 结构引号 = **2**（旧实现 = 4，属性被撑破）；注入用例 PASS |
| **H4** | `$&`/`$1` 被当替换模式展开 | 改用函数式替换 `(m0) => ...` | 活体：批注 `价格是 $& 而 $1 也特殊` 原样写入（旧代码会变成 `## 5. 我的批注`） |
| **H5** | 链接净化可绕过 → `href` 注入 | 收紧 URL 白名单 + `esc(u)` | 注入用例 PASS；正常链接与 `javascript:` 拒绝均 PASS |
| **H6** | 手工队列条目点击抛 TypeError | `data-q` 改用 `q.key`（handler 本就用 `x.key` 匹配） | 真实 IntraTomo 条目可解析出正确 key |
| **H7** | `library/` 缺失时 `/api/state` 500 | `findLocalPdf` 包 try/catch 返回 null | 无 `library/` 目录时不再抛 ENOENT |
| **H8** | 不可读文件使 node 进程退出 | `sendFile` 挂 `stream.on('error')` | 单测：错误路径返回 404 而非退出 |
| **H9** | 原地写 + 静默吞错丢历史 | `atomicWrite`（临时文件 + rename） | （会话间已修复，本轮确认存在） |
| **M5** | 审稿记录落到 `"null"` 键；无笔记也写 progress | key 改为 `arxiv \|\| note.key`；先写笔记失败则 404 不写盘 | 活体：无笔记 key → **404 `note_not_found`**，`progress` 未被污染 |
| **M21** | 标识符数字被当测量值 | `Evidence.numbers` 排除「完全嵌在单词中」的 token | 新测试 `Numeric tokens ignore identifiers` PASS；23 个真实记法值不变（`.958`/`RTX3090`→3090/`1.2GB`→1.2/`128×128×128`→128） |

## 关键回归证据（真实数据，非构造）

```
native/test.sh                          -> 37 passed; 0 failed
swift build -c release (native)         -> Build complete

活体服务（干净端口复核）：
  /api/state 基础连通                    -> 200
  C4 外源 Origin + text/plain            -> 403（笔记零污染）
  C3 POST /api/progress/__proto__        -> 400 bad_key
  H7 删除 library/ 后 /api/state         -> 200（修复前 500）
  H8 GET 不可读静态文件                  -> 进程存活
  同源写入批注                           -> 200，且「## 5. 我的批注」仍为 1 个
results-v1 (真实产物) validate           -> PASS   （顺序校验未误杀）
results-v3 (真实产物) validate           -> PASS
results-v2 (真实产物) validate           -> FAIL   （正确：header.excerpt 只含 FDK 一行，[20]/[28] 为真实缺口）
顺序违规计数 v1/v2/v3                    -> 0 / 0 / 0（共 150 格）
```

## 本轮更正的一处审查结论

初版报告称 `results-v2` 被「误拒」。**复核后确认该结论错误**：其 `header.excerpt` 仅覆盖 FDK 一行，
而 `header.v` 写了 `ASD-POCS [20]`、`IntraTomo3D [28]`，`20`/`28` 确为真实证据缺口——**拒绝是正确行为**。
已在 [M21] 条内标注更正。真实的 M21 缺陷是「诊断理由被污染 + 伪造值与标识符数字重合时漏检」。

## 本轮追加：把回归测试固化进仓库

上一轮的 JS 修复只在临时目录里验证过，没有留下可复跑的守护。本轮补上：

- 新增 **`native/js-test.sh`**（19 项检查）：JS 语法、前端函数级安全回归（直接从 `app/public/app.js`
  提取真实 `esc`/`inline` 实现，不手抄）、活体服务行为（C3/C4/H7/H8/M5 与批注小节计数）。
  用空闲端口、`mktemp` 临时数据目录，不触碰正式数据。
- README「回归检查」一节更新：`native/test.sh` 由「27 项」更正为 **37 项**，并加入 `js-test.sh` 用法。
- **修正一个无效测试**：初版 `testResultColumnTranspositionIsRejected` 其实是被 `rows.count >= 2`
  这条无关守卫拒绝的，**即使移除顺序校验它也会通过**（变异测试发现）。已重写为两列两行的用例：
  正确赋值 `PASS`、转置赋值被「未按表头列顺序」拒绝，移除修复后测试确实 `FAIL`。

### 变异测试（确认测试真的能失败）

| 回退的修复 | 测试反应 |
|---|---|
| H1 `esc` 去掉引号转义 | `FAIL: H1 esc 阻断属性注入` 等 4 项 |
| C4 移除 `sameOrigin` 拦截 | `FAIL: C4 外源 Origin 写入被拒: 期望 403，实际 200` |
| C2 移除顺序校验 | `FAIL: Expected error`（36 passed; 1 failed） |

同时也发现并修掉了 **`js-test.sh` 自身的一个 harness 缺陷**：初版用了 `set -e`，
第 2 步失败会直接退出，导致 C3/C4/H7/H8 根本不运行——已改为 `set -uo pipefail` 并显式累计失败数。

## 尚未修复（需你确认后再动）

以下项目**未改**，原因是涉及行为/协议选择或需要更多验证：

- **[M25] 验收报告呈现**：需把模块×运行矩阵与 71% 通过率写入 `REPORT.md`（非代码改动，等你确认口径）。
- **[M11] 出站请求超时**：加 `AbortSignal.timeout` 会改变长论文/慢网络下的行为，建议单独确认超时阈值。
- **[M2]/[M3]/[M11]/[M24] 等其余 Medium**：均不直接影响结果正确性，按你的优先级排期。
- **H2/H3 性能项**（O(n²) 去重、逐字符全量写盘）：改动面较大（涉及缓存失效与去抖），建议单独一轮。

---

# 修复记录（续）：视图层审计（并发子代理报告 + 独立复核）

一份针对 8 个 SwiftUI 视图文件的只读审计报告到达。我对其结论**逐条独立复现**后才采纳——其中 P0-1 与两条数据丢失路径经我实测确认成立，另有若干结论我复核后**不采纳**（见文末）。

## 已修复并验证

| 编号 | 缺陷 | 修改 | 验证 |
|---|---|---|---|
| **V1** | 有序列表判定过宽：`0.5 mm`→列表项 `5 mm`、`2.1 Datasets`→`1 Datasets`，**论文原文数字被静默改写** | `Markdown.swift` 要求「点号前全是数字」+「点号后紧跟空格」 | 独立编译真实解析器：5 个小数/编号章节全部回归段落，`1. correct item` 仍为列表；新增回归测试 + **变异测试**（回退后 5 项 FAIL） |
| **V2** | `openReader` 直接替换 session，不 flush 旧会话 → 从 Idea 弹层跳转丢失第④步草稿 | 抽出 `flushActiveSession()`，`openReader` 在切换论文前调用 | 新增回归测试 `Session swap flushes drafts`；**变异测试**（删掉 flush 后 2 项 FAIL） |
| **V3** | ⌘Q / 关窗口不落盘第④步笔记 | `App.swift` 增加 `NSApplication.willTerminateNotification` 钩子 | 编译通过；flush 逻辑与 V2 共用同一函数 |
| **V4** | `relaunch()` 用 `try?` 吞错后仍 `exit(0)` → 应用消失且更新未应用 | 改为 do/catch，失败时提示并留在当前实例；退出前先 flush | release 编译通过 |
| **V5** | `RichText.inline` 全范围覆盖 `.font`，抹掉粗体/斜体/等宽（Step② 与 Step① 不一致） | 先读 `NSInlinePresentationIntent`（实测粗体 2/斜体 1/等宽 4），再按段套字体 | 实测：修复后 `bold=true / italic=true / mono=true`，旧实现全部 `false` |
| **V6** | `PaperCard` 硬编码「代码：待核实」，扫描完成后仍提示未核 | 改为读 `store.codeSnapshots[paper.key]` | 编译通过 |
| **V7** | `ResultTableView` 选择器未绑定表格身份 → 重新生成后下拉框空白、差值静默消失 | `ResultsCard.identity(table)` 作为 `.id`，并加 `onChange` 清理失效选择 | 编译通过（注：内联表达式会让类型检查超时，已抽成静态方法/独立属性） |

## 我复核后**不采纳**的报告结论

- 报告把 `OpenReader` 未 flush 列为「P0」，但同时给出的「`session.drafts` 是引用类型、绑定安全」结论与我实测一致——不冲突，无需额外处理。
- 报告的 9.x 中若干条（`MarkdownView.onSelection` 死代码、`Int(confidence*100)` 防御、`URL(string:)!` 强制解包、CSV 换行归一化、调试自检写盘）**我未修改**：它们确实存在，但当前均不可触达或属工程规范，按「最小修改原则」留给后续排期。

## 本轮验证

```
native/test.sh                  40 passed; 0 failed   （上一轮 37，新增 3 条）
swift build -c release          Build complete
native/js-test.sh               20 项 PASS
变异测试：回退 V1 -> 5 项 FAIL；回退 V2 -> 2 项 FAIL
```

## 需要你注意

视图层改动涉及**界面行为**（强调样式、选择器重置、退出时落盘），我只做了编译与单元/逻辑级验证，
**没有做真实 UI 走查**（无 GUI 环境）。建议你运行一次 `native/build-app.sh` 后手动确认：
① 第②步左栏的粗体是否恢复；② 重新生成结果表后 A/B 选择器是否清空；③ 第④步写一半直接 ⌘Q 再打开是否还在。
