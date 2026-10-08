## 结论

- **views 数量**：论文中所有实验（5 个数据集）均使用 **50 个投影**（Page 6, §3.1 Data；Page 6, Table 1）。Aorta 数据集原始有 582 个投影，但实验只取 50 个（Page 6, Table 1）。
- **投影尺寸（detector resolution）**：因数据集而异——Chest 为 256×256，Jaw/Foot 为 512×512，Abdomen 为 1024×1024，Aorta 为 500×500（Page 6, Table 1）。
- **指标**：**PSNR（dB）** 与 **SSIM**（Page 6, §3.1 Implementation details；Page 7, Table 2）。
- **sparse-view 与 low-mAs 是否同一策略**：**不是**。论文明确把降剂量分为两条路径，并声明本文只关注后者（减少投影视角）（Page 1, §1）。

---

## 证据（论文事实）

**1. views 与投影尺寸**

- 人体器官数据（Chest/Jaw/Foot/Abdomen）：用 TIGRE 工具箱生成投影，"we capture 50 projections with 3% noise in the range of 180°"（Page 6, §3.1 Data）。
- Phantom（Aorta）：GE C-arm 采集 582 个 500×500 投影，但 "We only use 50 projections for experiments"（Page 6, §3.1 Data）。
- Table 1 汇总：5 个数据集的 "Number of projections" 列均为 50（Aorta 标注为 "50 (582)"），Detector resolution 分别为 256×256 / 512×512 / 512×512 / 1024×1024 / 500×500（Page 6, Table 1）。

**2. 指标**

- "We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM)"（Page 6, §3.1）。注意原文此处把 PSNR 误拼为 "PNSR"，但 Table 2 标题写的是 "PSNR/SSIM"（Page 7, Table 2）。
- 论文对两指标的解释：PSNR 统计评估伪影抑制，SSIM 衡量感知差异，二者越高表示重建越准确（Page 6, §3.1）。

**3. sparse-view vs low-mAs**

- 原文："There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction."（Page 1, §1）

---

## 解释（直觉 + 领域背景，非论文事实）

- **直觉上**：CT 剂量 ≈ 每张投影的射线强度 × 投影张数。降强度 = low-mAs（每张图更"暗/噪"）；减张数 = sparse-view（图更少但每张质量正常）。两者是"正交"的省剂量手段，可以叠加使用，但本文只处理后者。
- **为什么 sparse-view 难**：传统 CBCT 用几百张投影，本文输入少约 10×（Page 1, §1 提到 "The inputs of sparse-view CBCT are 10× fewer"）。视角不足 → 欠定问题 → 明显伪影。
- **指标直觉**：PSNR 对整体噪声/伪影幅度敏感；SSIM 更贴近人眼对结构/边缘的感知。二者常一起报告，因为单一指标可能被"平滑但糊"或"锐利但噪"的结果欺骗。

> ⚠️ AI 推断：论文用 50 views 属于其设定的 sparse-view 场景，但论文未给出"多少 views 以下才算 sparse"的定量定义——论文中未找到该阈值定义。

---

## 不确定性 / 需注意

- **"50 views" 是实验设定，不等于方法上限**：Fig. 4 展示了不同 views 数下的性能趋势，说明 views 是可变输入（Page 8, Fig. 4），但正文未在文字中列出 Fig. 4 所用的具体 views 数值——论文中未找到（仅能从图题知是 "different number of views"）。
- **Aorta 的 582 vs 50**：582 是扫描系统采集总数，50 是实验实际使用数，勿混淆（Page 6, Table 1）。
- **PSNR 拼写**：正文写 "PNSR"，表题写 "PSNR"，属原文笔误，指同一指标（Page 6 vs Page 7）。
- **low-mAs 是否被本文涉及**：论文只在 §1 提及它是另一条降剂量路径，未做任何 low-mAs 实验——论文中未找到相关实验。