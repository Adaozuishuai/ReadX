## 结论

- **views 数量**：论文在人体器官数据集和 phantom 数据集上都使用 **50 个投影**（Page 6, Table 1；Page 6 §3.1）。phantom 原始扫描有 582 个投影，但实验只用 50 个（Page 6 §3.1）。
- **投影尺寸（detector resolution）**：Chest 为 256×256；Jaw、Foot 为 512×512；Abdomen 为 1024×1024；Aorta 为 500×500（Page 6, Table 1）。
- **指标**：**PSNR（论文写作 PNSR）和 SSIM**（Page 6 §3.1；Page 7, Table 2）。
- **sparse-view 与 low-mAs 是否同一种策略**：**不是同一种策略**。论文明确把降低剂量分为两条路径——降低 source intensity 或减少 projection views，并声明本文聚焦后者（Page 1 §1）。

---

## 证据（论文事实）

**1) views 数量**
- 人体器官数据：用 TIGRE 在 180° 范围内采集 **50 projections，含 3% noise**（Page 6 §3.1）。
- Table 1 中五个数据集的 “Number of projections” 列：Chest/Jaw/Foot/Abdomen 均为 50；Aorta 标为 “50 (582)”（Page 6, Table 1）。
- phantom：GE C-arm 系统本身采集 **582 个 500×500 fluoroscopy projections**，角度范围 primary angle −103° 到 93°、secondary angle 0°；但实验**只用 50 个投影**（Page 6 §3.1）。

**2) 投影尺寸**
- 见 Table 1 的 “Detector resolution” 列：Chest 256×256；Jaw 512×512；Foot 512×512；Abdomen 1024×1024；Aorta 500×500（Page 6, Table 1）。

**3) 指标**
- 用 **PSNR（原文拼作 PNSR）和 SSIM** 做定量评价；PSNR 评估 artifact suppression，SSIM 衡量感知差异，越高越好（Page 6 §3.1）。
- Table 2 给出五种方法在五个数据集上的 PSNR/SSIM（Page 7, Table 2）。

**4) sparse-view vs low-mAs**
- 原文：“There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction.”（Page 1 §1）

---

## 解释（直觉理解）

- **views**：可以理解为“从多少个角度拍 X 光”。传统 CBCT 拍几百张，sparse-view 只拍几十张，所以每个角度之间的间隔更大，信息更少，重建更容易出现伪影（Page 1 §1 提到 sparse-view 输入比传统 CBCT 少约 10×）。
- **投影尺寸**：就是探测器面板的分辨率，即每张 2D 投影图有多少像素。尺寸越大，单张图包含的细节越多，但计算量也越大。
- **PSNR / SSIM**：PSNR 更像“整体误差/噪声压得干不干净”的数值指标；SSIM 更像“看起来结构像不像”的感知指标。两者都是与 ground truth 比较得到的。
- **sparse-view vs low-mAs**：这是两种不同的“降剂量”思路。low-mAs 是**每张投影拍得更弱/更少光子**（source intensity 降低），图像整体更噪；sparse-view 是**拍的角度数量变少**，主要问题是角度欠采样导致的伪影和不适定。论文选择的是后者（Page 1 §1）。

---

## 不确定性 / 缺失信息

- 论文中**未找到**对 “low-mAs” 这一术语的进一步定义或实验；论文只在 Page 1 §1 把它作为与 sparse-view 并列的另一条降剂量路径提及，并引用 [8]。
- 论文中**未找到**关于投影尺寸与 views 数量之间是否存在额外缩放/裁剪处理的说明（除 Table 1 所列数值外）。
- Table 1、Table 2 为 PDF 表格，材料提示“多栏或复杂合并单元格仍需核对”；上述数字按当前文本抽取结果报告，若需引用到正式写作，建议对照原 PDF 表格再核验一次。