## 结论

- **views 数量**：论文在全部五个数据集上都只用了 **50 个投影（50 projections）** 做稀疏视角重建实验 (Page 6, Table 1；Page 6, §3.1)。
- **投影尺寸（detector resolution）**：不同数据集不同——Chest 为 256×256，Jaw/Foot 为 512×512，Abdomen 为 1024×1024，Aorta 为 500×500 (Page 6, Table 1)。
- **指标**：**PSNR（论文写作 PNSR）和 SSIM** 两个指标 (Page 6, §3.1；Page 7, Table 2)。
- **sparse-view 与 low-mAs 是否同一策略**：**不是**。论文明确把降剂量分为两条路径——降低源强度（source intensity）或减少投影视角（projection views），并声明本文聚焦后者 (Page 1, §1)。

---

## 证据（论文事实）

**1) views 数量**
- Table 1 中五个数据集（Chest / Jaw / Foot / Abdomen / Aorta）的 "Number of projections" 列均为 **50** (Page 6, Table 1)。
- 正文：TIGRE 生成投影时 "we capture 50 projections with 3% noise in the range of 180°" (Page 6, §3.1)。
- Aorta 数据集：扫描系统本身采集了 **582** 个投影，但 "We only use 50 projections for experiments" (Page 6, §3.1；Table 1 中该行标注 "50 (582)")。
- 背景对比：论文称传统 CBCT 获取数百张图像，稀疏视角输入约为其 **1/10**（"The inputs of sparse-view CBCT are 10× fewer"）(Page 1, §1)。

**2) 投影尺寸 / 探测器分辨率**
- Table 1 "Detector resolution" 列：Chest 256×256；Jaw 512×512；Foot 512×512；Abdomen 1024×1024；Aorta 500×500 (Page 6, Table 1)。
- Aorta 的扫描系统描述为 "582 500×500 fluoroscopy projections" (Page 6, §3.1)。

**3) 指标**
- "We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM)" (Page 6, §3.1)。
- 指标含义（论文自述）：PSNR 统计评估伪影抑制性能，SSIM 衡量两信号的感知差异；数值越高表示重建越准确 (Page 6, §3.1)。
- Table 2 给出五方法在五数据集上的 PSNR/SSIM 数值 (Page 7, Table 2)。

**4) sparse-view 与 low-mAs 的关系**
- 原文："There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction." (Page 1, §1)

---

## 解释（直觉层面）

**为什么 50 views 算"稀疏"**：CBCT 常规扫描要转一整圈、采几百张投影；只留 50 张，等于把"从各个角度看物体"的信息砍掉约 90%。视角不够，反投影时很多方向的约束缺失，就会在重建体里留下条纹/模糊等伪影——这正是论文说 sparse-view 是 ill-posed 问题的直觉来源 (Page 1–2, §1)。

**为什么指标要两个一起看**：PSNR 是逐像素误差的统计量，对"整体噪声/伪影压得干不干净"敏感；SSIM 更看结构/纹理是否还像原图。一个方法可能 PSNR 高但边缘糊，所以论文两个都报 (Page 6, §3.1；Page 7, Table 2)。

**sparse-view vs low-mAs 的直觉区别**：
- **low-mAs（降源强度/管电流）**：视角数不变，但每张投影光子少 → 每张图更"吵"（量子噪声大）。
- **sparse-view（减视角）**：每张投影可能仍是正常剂量、噪声不大，但**角度采样不足** → 主要是"信息缺失/欠定"型伪影。
两者都会降剂量，但噪声来源和伪影性质不同，所以论文把它们并列为两种独立策略，并只研究后者 (Page 1, §1)。

---

## 不确定性 / 需注意

- **AI 推断**：上面对"low-mAs 表现为量子噪声、sparse-view 表现为角度欠采样"的机理解释属于领域常识性推断，论文本身只写了"两种降剂量方式"这一句 (Page 1, §1)，并未展开噪声机制对比。
- **论文中未找到**：论文未报告各数据集投影的**像素物理尺寸（mm/pixel）**、未报告 sparse-view 与 low-mAs **联合使用**的实验，也未报告除 PSNR/SSIM 之外的指标（如 RMSE、LPIPS 等）。
- **术语提示**：论文正文把 PSNR 写作 "PNSR"（拼写不一致），Table 2 表头写 "PSNR" (Page 6, §3.1；Page 7, Table 2)——引用时建议以 PSNR 为准并注明原文拼写差异。
- Table 1、Table 2 为 PDF 多栏/合并单元格表格，按规则需核对原始排版；上述数字取自表内行标签对应值，若需精确引用建议回原文表格复核 (Page 6, Table 1；Page 7, Table 2)。