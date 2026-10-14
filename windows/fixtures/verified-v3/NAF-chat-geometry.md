## 结论

- **views 数量**：论文在全部五个数据集上都只用了 **50 个投影**（Page 6, Table 1；Page 6 §3.1）。其中 Aorta 数据集原始有 582 个投影，实验只取其中 50 个（Page 6, Table 1；Page 6 §3.1）。
- **投影尺寸（detector resolution）**：Chest 为 256×256，Jaw 为 512×512，Foot 为 512×512，Abdomen 为 1024×1024，Aorta 为 500×500（Page 6, Table 1）。
- **评价指标**：**PSNR（论文写作 PNSR）** 与 **SSIM**（Page 6 §3.1）。
- **sparse-view 与 low-mAs 是否同一策略**：**不是**。论文明确把降剂量分为两条路径——降低 source intensity 或减少 projection views，并声明本文聚焦后者（Page 1 §1）。论文中未找到关于 low-mAs 的任何实验或方法细节。

---

## 证据（论文事实）

**1. views 与投影尺寸**

Table 1 列出五个数据集的扫描方式、扫描范围、投影数、探测器分辨率（Page 6, Table 1）：

| Dataset | CT dimension | Scanning method | Scanning range | Number of projections | Detector resolution |
|---|---|---|---|---|---|
| Chest | 128×128×128 | TIGRE | 0°~180° | 50 | 256×256 |
| Jaw | 256×256×256 | TIGRE | 0°~180° | 50 | 512×512 |
| Foot | 256×256×256 | TIGRE | 0°~180° | 50 | 512×512 |
| Abdomen | 512×512×463 | TIGRE | 0°~180° | 50 | 1024×1024 |
| Aorta | 512×512×510 | GE C-arm | −103°~93° | 50 (582) | 500×500 |

正文补充：human organ 数据用 TIGRE 在 180° 范围内捕获 50 个投影，并加 **3% 噪声**（Page 6 §3.1）；Aorta 用 GE C-arm 采集 582 个 500×500 透视投影，但实验只用 50 个（Page 6 §3.1）。

**2. 指标**

"we evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM)"（Page 6 §3.1）。论文说明 PSNR 统计性地评估伪影抑制，SSIM 衡量感知差异，二者越高越好（Page 6 §3.1）。Table 2 给出五种方法在五个数据集上的 PSNR/SSIM（Page 7, Table 2）。

**3. sparse-view vs low-mAs**

"There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction."（Page 1 §1）

---

## 解释（直觉 + 领域背景，非论文事实）

- **为什么 50 views 算 sparse**：论文说传统 CBCT 获取数百张图像，而 sparse-view 的输入少 10 倍（Page 1 §1）。50 相对 582（Aorta 原始）大致就是这个量级差。
- **sparse-view 与 low-mAs 的区别（领域解释）**：这是两种独立的降剂量手段。low-mAs 是降低每次曝光的管电流/光子数，结果是**每个投影噪声更大**（量子噪声主导），但视角数不变；sparse-view 是减少投影角度数，结果是**角度采样不足**，主要产生条状伪影、缺失角度伪影（ill-posed）。二者可以叠加使用，但退化机理不同，因此重建算法侧重也不同。论文只处理后者，且其 human organ 数据是在 50 views 上额外加了 3% 噪声（Page 6 §3.1）——**注意：这属于在 sparse-view 上人为加噪，不等于论文研究了 low-mAs 策略**（AI 推断）。
- **指标直觉**：PSNR 对整体误差/噪声敏感，SSIM 更贴近人眼对结构、边缘的感知。论文用两者互补，避免只看单一数值（Page 6 §3.1）。

---

## 不确定性 / 论文中未找到

- 论文中**未找到** low-mAs 相关的实验、对比或方法描述；只在引言中作为"另一种降剂量方式"被提及（Page 1 §1）。
- 论文中**未找到** 3% 噪声的具体定义（是相对噪声标准差还是其他口径），也未说明 Aorta 真实投影是否加噪（Page 6 §3.1 只对 human organ 提到 3% noise）。
- 论文中**未找到** 50 views 的选取依据（为何是 50 而非其他数量）；Fig. 4 只展示了不同 views 数下的性能趋势，但正文未给出具体数值表（Page 8, Fig. 4）。
- Table 1 中 Aorta 的 "50 (582)" 表示实验用 50、原始 582，此为论文表格标注（Page 6, Table 1）；其余数据集未标注原始投影总数。
- 论文把 PSNR 拼写为 "PNSR"（Page 6 §3.1），属原文用词，指标本身即 peak signal-to-noise ratio。