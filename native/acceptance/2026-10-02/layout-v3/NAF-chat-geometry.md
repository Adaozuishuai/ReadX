## 结论

- **views 数量**：论文在全部五个数据集上都只用 **50 个投影**（Page 6, Table 1；Page 6, §3.1）。其中 Aorta 数据集原始扫描有 582 个投影，但实验只取 50 个（Page 6, Table 1；Page 6, §3.1）。
- **投影尺寸（detector resolution）**：Chest 256×256；Jaw 512×512；Foot 512×512；Abdomen 1024×1024；Aorta 500×500（Page 6, Table 1）。
- **指标**：**PSNR（论文写作 PNSR）和 SSIM**（Page 6, §3.1；Page 7, Table 2）。
- **sparse-view 与 low-mAs 是否同一策略**：**不是**。论文明确把降剂量分为两条路径——降低 source intensity 或减少 projection views，并声明本文聚焦后者（Page 1, §1）。low-mAs 属于前者，论文未做实验。

---

## 证据（论文事实，逐条标 Page）

**1. views 数量**
- 五个数据集（Chest / Jaw / Foot / Abdomen / Aorta）的 "Number of projections" 列均为 50（Page 6, Table 1）。
- 正文："In TIGRE [5], we capture 50 projections with 3% noise in the range of 180°."（Page 6, §3.1，指 human organ 数据）
- Aorta："This system captures 582 500×500 fluoroscopy projections... We only use 50 projections for experiments."（Page 6, §3.1）
- 扫描角度范围：human organ 为 0°∼180°；Aorta 为 −103°∼93°（Page 6, Table 1）。

**2. 投影尺寸**
- 见上 Table 1 各行 "Detector resolution"（Page 6, Table 1）。
- 注意：Aorta 的 500×500 在正文中也有对应描述（Page 6, §3.1）。

**3. 指标**
- "We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM) [25]."（Page 6, §3.1）
- 指标含义（论文自述）：PSNR 统计评估 artifact 抑制，SSIM 衡量感知差异；数值越高表示重建越准确（Page 6, §3.1）。
- 结果表 Table 2 给出五方法 × 五数据集的 PSNR/SSIM（Page 7, Table 2）。

**4. sparse-view vs low-mAs**
- "There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction."（Page 1, §1）

---

## 解释（直觉层面）

**为什么 50 views 算 "sparse"**：论文说传统 CBCT 获取数百张图像，而 sparse-view 的输入少 10 倍（Page 1, §1）。50 相对 582（Aorta 原始）大致就是这个量级差。

**为什么用 PSNR + SSIM 两个指标**：可以理解为"一个看像素误差、一个看结构相似"。PSNR 对 artifact/噪声敏感，SSIM 更贴近人眼对结构的感知（Page 6, §3.1 的论文自述）。两者一起用，避免只看单一维度。

**sparse-view 与 low-mAs 的区别（直觉）**：
- low-mAs = 每个角度都拍，但每次"曝光更弱"→ 单张投影噪声大。
- sparse-view = 曝光正常，但"拍的角度少"→ 信息覆盖不足，产生 artifact。
- 两者都会降剂量，但**失效机制不同**：前者是噪声问题，后者是欠采样/病态问题。论文只处理后者（Page 1, §1）。

---

## 不确定性 / 需注意

- **指标拼写**：论文正文与表头写作 "PNSR"（Page 6, §3.1；Page 7, Table 2），标准写法应为 PSNR。这是原文用词，非我改写。
- **3% noise 的适用范围**：正文 "50 projections with 3% noise" 出现在 human organ 段落（Page 6, §3.1）；Aorta 是否同样加噪，论文中未明确说明——**论文中未找到** Aorta 加噪的表述。
- **low-mAs 相关实验**：论文未做，**论文中未找到** 任何 low-mAs 或降低 source intensity 的实验结果。
- **"50 views 是否对所有数据集都最优"**：论文有 views 数量变化的实验（Fig. 4，Page 8），但正文只说"性能随输入 views 增加而提升"（Page 8, §3.2），未给出各 views 下的具体数值——**论文中未找到** Fig. 4 的具体数字。
- **领域解释部分**（low-mAs 与 sparse-view 失效机制的区别）属于 AI 推断/领域背景，非论文原文结论；论文只做了"两条降剂量路径"的二分陈述（Page 1, §1）。