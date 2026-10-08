## 结论

- **views**：论文实验统一使用 **50 个投影视角**（人体器官数据集和 phantom 数据集都是 50 views）(Page 6, Table 1)。
- **投影尺寸**：不同数据集不同——Chest 256×256、Jaw 512×512、Foot 512×512、Abdomen 1024×1024、Aorta 500×500 (Page 6, Table 1)。
- **指标**：**PSNR（论文写作 PNSR）和 SSIM** (Page 6, §3.1)。
- **sparse-view 与 low-mAs 是否同一策略**：**不是**。论文明确把降剂量分为两条路径——降低 source intensity 或减少 projection views，并声明本文聚焦后者 (Page 1, §1)。low-mAs 属于前者，论文中未展开。

---

## 证据（论文事实）

**1. views 数量**

- 人体器官数据：用 TIGRE 生成投影，"we capture 50 projections with 3% noise in the range of 180°" (Page 6, §3.1)。
- Phantom（Aorta）：系统本身采集 582 个投影，但 "We only use 50 projections for experiments" (Page 6, §3.1)。
- Table 1 中五个数据集的 "Number of projections" 列均为 50，Aorta 行标注 "50 (582)" (Page 6, Table 1)。

**2. 投影尺寸（Detector resolution）**

Table 1 逐行给出 (Page 6, Table 1)：

| 数据集 | Detector resolution |
|---|---|
| Chest | 256×256 |
| Jaw | 512×512 |
| Foot | 512×512 |
| Abdomen | 1024×1024 |
| Aorta | 500×500 |

Aorta 的 500×500 与正文 "582 500×500 fluoroscopy projections" 一致 (Page 6, §3.1)。

**3. 指标**

- "We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM)" (Page 6, §3.1)。
- 论文对两指标的解释：PSNR 统计评估伪影抑制，SSIM 衡量感知差异；数值越高表示重建越准确 (Page 6, §3.1)。
- 具体数值见 Table 2 (Page 7)。

**4. sparse-view vs low-mAs**

- "There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction." (Page 1, §1)

---

## 解释（直觉）

**为什么 50 views 算 sparse**：论文说传统 CBCT 获取数百张图像，而 sparse-view 的输入少 10 倍 (Page 1, §1)。Aorta 的 582 个投影只取 50 个，正好约 1/10，与这个说法吻合。

**为什么用两个指标**：PSNR 对噪声/伪影这类逐像素误差敏感，SSIM 更贴近人眼对结构、边缘的感知。论文用两者互补，避免只看单一数值 (Page 6, §3.1)。注意论文原文把 PSNR 拼成了 "PNSR"，这是笔误，指标本身仍是 peak signal-to-noise ratio。

**sparse-view 与 low-mAs 的区别（领域解释，非论文事实）**：两者都是降剂量手段，但物理机制不同——sparse-view 减少的是**角度采样数**，导致的是欠采样/有限角伪影（ill-posed）；low-mAs 降低的是**每帧光子数**，导致的是量子噪声升高。论文只处理前者，且其数据里人体器官投影还额外加了 3% 噪声 (Page 6, §3.1)，但这是仿真噪声，不等同于 low-mAs 场景。**论文未报告**任何 low-mAs 实验。

---

## 不确定性

- Table 1 是 PDF 物理行布局，多栏/合并单元格可能被文本抽取打乱，**行列对应关系建议对照原 PDF 核对**；我上面按行标签（数据集名）与列标签（Detector resolution）对应，但抽取文本未显式保留列边界。
- "50 (582)" 的括号含义，论文正文解释为系统共采 582 个、实验只用 50 个 (Page 6, §3.1)，但 Table 1 单元格本身未加注。
- 论文提到超参数细节在 supplementary material (Page 6, §3.1)，**该补充材料不在本次全文范围内**，故采样点数等更细的设置此处无法给出。
- 关于 low-mAs，论文仅在 §1 提及它是另一条降剂量路径，**论文中未找到**任何 low-mAs 的实验、指标或对比。