# Critical Review: 《Neural Attenuation Fields for Sparse-View CBCT Reconstruction》

以下评审严格基于论文正文内容。凡论文未提供证据的判断，均标注「论文中未说明」；凡属评审人推断，均标注「推断」。

---

## 1. Strengths

**S1. 问题设定明确且动机清晰。** 论文将 sparse-view CBCT reconstruction 定位为低剂量 CT 的两条路径之一（降低 source intensity 或减少 projection views），并明确选择后者 (Page 1)。同时指出 CBCT 相比 FBCT 的困难在于输入维度增加导致的空间与计算复杂度上升 (Page 1–2)。这一动机链条完整。

**S2. 自监督设定减少了对训练数据的依赖。** 论文明确将 "self-supervised" 定义为「不需要外部 CT 扫描，只需要感兴趣对象的 X-ray projections」(Page 2)，并在贡献中重申「Neither external datasets nor structural prior is needed except projections of a subject」(Page 3)。这是相对其所述多数 learning-based 方法（需 extensive datasets，Page 2）的明确差异点。

**S3. 对 encoder 选择给出了基于数据特性的论证，而非仅凭指标。** 论文论证 frequency-domain encoding 是 dense encoder，对 CBCT 冗余，理由有二：人体由若干 homogeneous media 组成，attenuation coefficients 在介质内部近似均匀、仅在边缘变化；自然物体偏好平滑，器官形状简单（spindle/cylinder）(Page 4)。据此采用 hash encoder，并指出其 many-to-one 特性契合器官稀疏性、且可训练地选择合适频谱 (Page 5)。这是有物理/解剖依据的设计选择。

**S4. 网络规模与运行时间的对比有具体数字支撑。** 论文称其 MLP 为 4 层、前三层 32-channel，而 Zang et al. [28] 使用 6 层 256-channel MLP，故「Our network is 10× smaller」(Page 5)；运行时间上称 NAF 与 iterative methods 相近，且比 IntraTomo3D 快 3× (Page 8)。摘要中给出 10–40 分钟的重建时间 (Page 3)。

**S5. 实验覆盖了 human organ 与 phantom 两类数据。** 五个数据集：chest、jaw、foot、abdomen（human organ）与 aorta（phantom）(Page 6, Table 1)。phantom 使用真实 C-arm 系统采集（GE C-arm Medical System，582 张 500×500 fluoroscopy projections），并以 inbuilt algorithms 生成的 512×512×510 CT 作为 ground truth (Page 6)。

**S6. 提供了 slice-wise 与 view-number 两个维度的补充分析。** Fig. 3 显示 NAF 在 abdomen 数据集所有 slice 上优于其他方法 (Page 8)；Fig. 4 显示性能随输入 view 数增加而提升，且 NAF 在多数情况下更优 (Page 8)。

---

## 2. Weaknesses

**W1. human organ 数据的验证属于 simulation，而非真实 sparse-view 采集。** 论文明确说明：这些数据集「only provide volumetric CT scans」，因此 projections 是由 TIGRE toolbox 生成，捕获 50 个投影、3% 噪声、180° 范围，再用 raw volumetric CT 评估 (Page 6)。因此 chest/jaw/foot/abdomen 四组结果**不能**视为真实 sparse-view CBCT 扫描的验证。真实采集仅见于 aorta phantom（50/582 projections，Page 6）。这是验证范围的关键限制。

**W2. 真实数据（aorta）上的绝对指标明显偏低，且论文未讨论原因。** Table 2 中 NAF 在 Aorta 上为 30.34/.88，而其在 Chest/Jaw/Foot/Abdomen 上为 33.05/.96、34.14/.94、31.63/.94、34.45/.95 (Page 7)。论文正文仅以 abdomen 的 +3.07 dB 举例说明优势 (Page 7)，未对 aorta 上所有方法（FDK 12.11/.21、SART 27.31/.77 等）整体偏低的现象给出解释。论文中未说明该差异是否源于真实噪声、几何标定、角度范围（−103°~93°）或 ground truth 生成方式。

**W3. 缺少对 hash encoder 关键超参数的消融。** 论文称「We use the same hyper-parameter setting for hash encoder as [14]」，并将更多超参数细节放在 supplementary material (Page 6)。正文未报告 hash table size T、resolution levels L、feature dimension 等对结果的影响，也未与 frequency encoder 在**同等网络容量**下做对照。因此「hash encoder 优于 frequency encoder」的结论在正文中主要依赖 IntraTomo3D 这一外部实现的对比，而非受控消融（推断：受控对照可能存在于 supplementary，但正文未呈现）。

**W4. 与 IntraTomo3D 的对比存在实现差异，可能混淆结论。** 论文称「We implement a CBCT variant of IntraTomo [28], named IntraTomo3D」(Page 6)，即该 baseline 由作者自行改造。论文未说明改造的具体内容与调参程度。因此 NAF 相对 IntraTomo3D 的优势中，有多少来自 hash encoding、有多少来自实现/调参差异，论文中未说明。

**W5. 采样数 N 与 CT 尺寸的对应关系只给了一个例子。** 论文仅说明「we sample 192 points along each ray for the 128×128×128 chest CT」，并称 N 应大于 desired CT size 以保证每个 grid cell 至少一个采样点 (Page 4, Page 6)。对于 256³、512³ 等更大体积的 N 取值，论文中未说明（称在 supplementary）。

**W6. 缺少对噪声鲁棒性的系统评估。** human organ 数据统一加 3% 噪声 (Page 6)，但论文未报告不同噪声水平下的表现，也未报告真实 aorta 数据的噪声特性。论文中未说明 NAF 在低剂量/高噪声条件下的退化行为。

**W7. 缺少内存占用的定量报告。** 论文在 related work 中批评 self-supervised 方法「operate under FBCT settings considering network capacity and memory consumption」(Page 2)，但自身仅报告运行时间 (Fig. 5, Page 9)，未报告显存占用。论文中未说明 NAF 的 memory footprint。

**W8. 统计显著性未报告。** Table 2 给出 PSNR/SSIM 数值 (Page 7)，但未说明是否多次运行、是否报告方差或置信区间。论文中未说明结果的稳定性。

---

## 3. Questions

**Q1.** human organ 四组数据的 projections 由 TIGRE 从 ground-truth volume 前向投影生成 (Page 6)。在这种 simulation 设定下，forward model 与 NAF 的 synthesis model（Eq. 2, Page 5）是否完全一致？若一致，是否会使任务比真实采集更容易？论文中未说明二者的一致性程度。

**Q2.** aorta 数据使用 50/582 projections，角度范围为 −103°~93°（约 196°，非完整 360°）(Page 6, Table 1)。该角度范围是否构成 limited-angle 而非单纯 sparse-view？论文中未说明其对重建难度的影响。

**Q3.** Table 1 中 Chest/Jaw/Foot/Abdomen 的 "Scanning range" 列均标注 0°~180°，而 Aorta 为 −103°~93° (Page 6)。0°~180° 是否足以覆盖 cone-beam 几何所需的角度？论文中未说明。

**Q4.** 论文称 NAF 不需要 structural prior (Page 3)，但 hash encoder 的 many-to-one 特性被论证为「conforms to the sparsity nature of human organs」(Page 5)。这是否意味着方法隐含了对「人体器官稀疏/平滑」这一先验的依赖？若应用于非人体对象，是否仍成立？论文中未说明。

**Q5.** Eq. 3 的 loss 为纯 L2 projection loss (Page 5)，未含任何正则项。论文在 related work 中指出 iterative methods 依赖 regularization (Page 2)，并批评 ASD-POCS 的 TV 正则「encourages removing high-frequency details」(Page 8)。NAF 不使用显式正则，是否完全依赖 hash encoder 的稀疏性来隐式正则化？论文中未说明。

**Q6.** 论文称 NAF「spends similar running time to iterative methods」(Page 8)，但 Fig. 5 的具体数值未在正文给出。各方法在五个数据集上的具体收敛时间是多少？论文中未说明（仅以图呈现）。

**Q7.** 最终输出通过 query voxel grid 得到 (Page 5)。voxel grid 的分辨率是否与训练时采样密度匹配？若 query 分辨率高于训练采样密度，是否会出现插值伪影？论文中未说明。

**Q8.** 论文摘要与结论均称「state-of-the-art accuracy」(Page 1, Page 9)。该表述的比较范围是本文所选的四个 baselines，还是更广泛的文献？论文中未说明。

---

## 4. Missing Experiments

**M1. 真实 sparse-view CBCT 采集上的验证。** 目前仅 aorta phantom 为真实采集，且仅一个样本、一个解剖部位 (Page 6)。缺少真实人体或更多真实 phantom 的 sparse-view 验证。

**M2. Encoder 的受控消融。** 缺少在相同 MLP 容量、相同训练预算下，frequency encoder vs. hash encoder 的直接对比；缺少 hash encoder 各超参数（T、L、feature dim）的敏感性分析（正文层面）。

**M3. 采样数 N 的消融。** 缺少 N 对精度与时间的影响曲线，尤其对 256³/512³ 体积。

**M4. 噪声水平与 view 数的联合分析。** Fig. 4 仅给出 view 数的影响 (Page 8)，未叠加噪声维度；human organ 固定 3% 噪声 (Page 6)。

**M5. 内存/显存报告。** 论文以 memory consumption 作为批评 FBCT 自监督方法的理由 (Page 2)，但未报告自身内存占用。

**M6. 收敛性与稳定性分析。** 缺少多次运行的方差、收敛曲线、对初始化/随机种子的敏感性。

**M7. 与更多 self-supervised CT 方法的对比。** 论文提到存在 self-supervised 方法 [1,28] (Page 2)，但 baseline 中仅纳入 IntraTomo3D（[28] 的 CBCT 变体），未纳入 [1]（Learned primal-dual）。

**M8. 角度范围/几何误差的鲁棒性。** 真实 C-arm 系统存在几何标定误差，论文未报告 NAF 对 scanner geometry 误差的敏感性。

**M9. 推理/查询阶段耗时。** 论文报告训练时间 (Fig. 5)，但最终 voxel query 生成 CT 的耗时未单独报告。

---

## 5. 适用边界

**B1. 任务边界：sparse-view CBCT，非通用 CT。** 论文聚焦于从数十张 projections 重建 volumetric attenuation field (Page 1)，并明确其输入为 cone-beam 2D projections。方法依赖 scanner geometry 进行 ray sampling (Page 3–4)，因此**推断**其迁移到其他成像几何需重新适配 forward model。

**B2. 数据边界：自监督，但需目标对象的 projections。** 论文强调不需要 external training data (Page 2–3)，但每个新对象都需重新优化网络（per-subject optimization）。论文中未说明是否支持跨对象泛化或 amortized inference。**推断**：NAF 属于 per-scene optimization 范式，重建时间 10–40 分钟 (Page 3) 是每个对象单独计算的成本。

**B3. 验证边界：以 simulation 为主。** 五组数据中四组（chest/jaw/foot/abdomen）的 projections 由 TIGRE 从 ground-truth volume 生成 (Page 6)，属 simulation；仅 aorta 为真实 C-arm 采集。因此论文所声称的「state-of-the-art accuracy」(Page 1) 主要在 simulation 条件下成立，真实采集证据仅来自单一 phantom。这是复现与推广时必须明确的前提。

**B4. 先验边界：隐含依赖人体器官的平滑性与稀疏性。** hash encoder 的采用理由明确建立在「human body consists of several homogeneous media」「natural objects favor smoothness」(Page 4) 之上。**推断**：对纹理复杂、非平滑或非人体对象，该设计前提可能不成立；论文中未说明此类场景的表现。

**B5. 计算边界：单卡 RTX 3090。** 所有实验在 single RTX 3090 GPU 上完成 (Page 6)。论文中未说明在更低显存设备或多卡下的可行性。

**B6. 复现边界：关键超参数在 supplementary。** 正文仅给出 learning rate（1×10⁻³ → 1×10⁻⁴）、batch size（2048 rays）、chest 的 N=192，其余超参数「can be found in the supplementary material」(Page 6)。**推断**：完整复现依赖 supplementary 的可获得性；仅凭正文不足以复现全部配置。

**B7. 评价边界：PSNR/SSIM 为主。** 论文以 PSNR 与 SSIM 作为定量指标 (Page 6)，并说明 PSNR 评估 artifact suppression、SSIM 评估感知差异。论文中未说明是否采用 task-based 指标（如病灶可检测性）或临床读者研究。**推断**：其「feasible for clinical CT applications」(Page 3) 的表述缺乏临床层面的验证支撑。

---

**总评（基于以上证据）：** 论文在方法设计上给出了与数据特性挂钩的明确论证（hash encoding 的引入理由，Page 4–5），并在运行时间与网络规模上提供了具体对比数字 (Page 5, Page 8)。其主要局限在于：验证以 simulation 为主（四组 human organ 数据由 TIGRE 生成，Page 6），真实采集仅一个 phantom；encoder 与采样数的受控消融未在正文呈现；与 IntraTomo3D 的对比涉及作者自行实现的 CBCT 变体 (Page 6)，其改造细节未说明。因此，论文所报告的「state-of-the-art accuracy」应被理解为**在其设定的 simulation 与单一 phantom 验证范围内、相对其选定四个 baselines 的结果**，而非对真实临床 sparse-view CBCT 的普适结论。