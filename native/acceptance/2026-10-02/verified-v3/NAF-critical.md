# Critical Review: 《Neural Attenuation Fields for Sparse-View CBCT Reconstruction》

以下评审严格基于论文正文（Page 1–11）所报告的内容。凡论文未说明者，均标注「论文中未说明」；凡属本人推断者，均标注「推断」。

---

## 1. Strengths

**S1. 问题设定明确，且方法定位为 self-supervised、无需外部训练数据。**
论文将 NAF 定义为「a fast self-supervised solution for sparse-view CBCT reconstruction ... requires no external training data」(Page 1)，并在贡献中重申「Neither external datasets nor structural prior is needed except projections of a subject」(Page 3)。这一设定针对了论文所指出的现有 learning-based 方法痛点：「Most of these methods [3,11,22,27] need extensive datasets for network training ... it is difficult to apply a trained model of one application to another」(Page 2)。该定位在论文叙述内部是自洽的。

**S2. 对 frequency encoder 在 CBCT 场景下的低效性给出了可检验的论证，并据此替换为 hash encoder。**
论文指出 frequency encoder 输出维度大（「the size of encoder output is set to 256 or greater」, Page 4），导致后续网络必须更宽更深、训练耗时以小时计 (Page 4)；并给出两条针对 CBCT 的稀疏性/平滑性理由：「a human body usually consists of several homogeneous media ... High-frequency features are not necessary unless for points near edges」以及「natural objects favor smoothness ... Their smooth surfaces can be easily learned with low-dimensional features」(Page 4)。据此采用 hash encoder，输出维度「32 in our setting」(Page 5)。这是「动机—设计」链条较完整的一处。

**S3. 网络规模与训练时间的对比有具体数字支撑。**
论文报告 NAF 的 MLP 为「4 fully-connected layers. The first three layers are 32-channel wide ... the last layer has one neuron followed by a sigmoid activation」，并明确对比「Zang et al. [28] use a 6-layer 256-channel MLP ... Our network is 10× smaller」(Page 5)。时间上报告「NAF spends similar running time to iterative methods and is 3×faster than the frequency-encoding deep learning method IntraTomo3D」(Page 8)，且「IntraTomo3D requires more than one hour to train the network」(Page 8)。摘要中给出「within 10-40 minutes」(Page 3)。

**S4. 在五个数据集上同时报告 PSNR 与 SSIM，并给出逐切片与逐视角的补充分析。**
Table 2 覆盖 Chest / Jaw / Foot / Abdomen / Aorta 五个数据集与五种方法 (Page 7)；Fig. 3 报告 abdomen 上的 slice-wise 表现 (Page 8)；Fig. 4 报告不同视角数下的表现 (Page 8)。多维度报告优于仅给单一总体指标。

**S5. 对基线方法的失败模式给出了定性解释，而非仅罗列指标。**
例如 FDK「restores low-quality models with notable artifacts, as analytical methods demand large amounts of projections」；ASD-POCS「heavily smeared because total-variation regularization encourages removing high-frequency details, including unwanted noise and expected tiny structures」；IntraTomo3D「edges between media are slightly blurred, which shows that the frequency encoder fails to teach the network to focus on edges」(均 Page 8)。

---

## 2. Weaknesses

**W1. 人体器官数据全部为仿真投影，验证范围受限；论文未在真实人体 CBCT 投影上验证。**
论文明确说明：「Since these datasets only provide volumetric CT scans, we generate projections by a tomographic toolbox TIGRE [5]. In TIGRE [5], we capture 50 projections with 3% noise in the range of 180°」(Page 6)。即 Chest / Jaw / Foot / Abdomen 四组均为 simulation 数据，噪声模型为「3% noise」这一单一设定，论文中未说明该噪声是何种统计模型（如 Poisson 还是 Gaussian）、是否模拟 scatter、beam hardening 或 detector blur。真实投影仅来自 Aorta phantom（硅胶主动脉体模，GE C-arm），且仅此一例 (Page 6)。因此论文声称的「feasible for clinical CT applications」(Page 3) 在证据上仅由仿真 + 单一 phantom 支撑。**这是验证范围问题，不是方法本身的缺陷，但结论外推需谨慎。**

**W2. 训练/评估的 ground truth 与输入投影之间存在「同源」风险，论文未讨论。**
人体数据中，投影由 TIGRE 从体数据生成，评估又「evaluate its performance with the raw volumetric CT data」(Page 6)。这意味着 forward model 与评估基准来自同一离散体数据。论文中未说明是否在生成投影时引入了与重建时不同的几何/物理模型（如不同的 detector 采样、不同的插值），也未讨论这种同源性对 PSNR/SSIM 的可能高估。**论文中未说明。**

**W3. 关键超参数与实现细节被外置，正文不足以复现。**
论文称「We use the same hyper-parameter setting for hash encoder as [14]. More details of hyper-parameters can be found in the supplementary material」(Page 6)。但本评审所依据的全文（Page 1–11）不含 supplementary material，因此 hash encoder 的层数 L、表大小 T、每层特征维度、resolution 范围等均「论文中未说明」。此外，采样点数仅给出一例：「we sample 192 points along each ray for the 128×128×128 chest CT」(Page 6)，其余四个数据集的 N 值「论文中未说明」。学习率调度只给出「starts at 1×10⁻³ and steps down to 1×10⁻⁴」(Page 6)，但 step 的触发条件/迭代次数「论文中未说明」。**复现依赖 supplementary material，这是复现前提，不应被隐藏。**

**W4. 时间对比的公平性前提未充分交代。**
Fig. 5 报告 running time，论文称「All methods use CUDA [15] to accelerate the computation process」(Page 8)，且「All experiments are conducted on a single RTX 3090 GPU」(Page 6)。但论文中未说明各基线（FDK / SART / ASD-POCS）是否使用同一实现来源、是否经过同等程度的调优、迭代方法的停止准则如何设定（「converge to stable results」, Page 9 图注，但收敛判据「论文中未说明」）。因此「NAF spends similar running time to iterative methods」这一比较的公平性前提不完整。

**W5. 视角数变化的实验只在一个数据集上给出，且未报告极端稀疏情形。**
Fig. 4 为「Performance under different number of views on the abdomen dataset」(Page 8)，仅 abdomen 一个数据集。论文正文只给出定性描述「the performance increases with the rise of input views. Our methods achieves better results than others under most circumstances」(Page 8)。注意「most circumstances」这一措辞本身暗示存在 NAF 不占优的情形，但论文未指出是哪些情形。具体视角数取值「论文中未说明」（图内数值需核对原 PDF）。

**W6. 摘要与结论中的「state-of-the-art」表述强于证据所能支撑的范围。**
论文称「achieves state-of-the-art accuracy」(Page 1, Page 3)。但对比范围限于四种基线（FDK、SART、ASD-POCS、IntraTomo3D），且其中三种为传统方法、一种为作者自行实现的 CBCT 变体（「We implement a CBCT variant of IntraTomo [28], named IntraTomo3D」, Page 6）。论文中未说明是否与近年其他 sparse-view CBCT 深度学习方法（如基于 score-based / diffusion / 其他 INR 的 CBCT 工作）比较。**因此「state-of-the-art」应理解为「在本文所选基线集合内最优」，而非领域全局最优。**

**W7. 指标提升幅度与统计显著性未讨论。**
Table 2 中部分差距较小，例如 Jaw 上 ASD-POCS 为 32.78/.93、NAF 为 34.14/.94 (Page 7)；Foot 上 IntraTomo3D 为 31.43/.91、NAF 为 31.63/.94 (Page 7)。论文未报告多次运行的方差、未做显著性检验，也未说明这些数值是单次运行还是多次平均。**论文中未说明。** 因此不能仅凭数值更高就判定方法在该数据集上稳健更优。

**W8. 未报告失败案例或方法失效条件。**
论文未给出 NAF 重建质量下降的具体场景（如金属植入物、极端稀疏视角、大体积数据的内存瓶颈）。仅提到「The sampling quantity of each ray depends on the size of CT data」(Page 6)，暗示大体积需要更多采样，但未讨论由此带来的显存/时间代价上限。

---

## 3. Questions

**Q1（验证范围）** 人体器官的四组实验全部使用 TIGRE 生成的仿真投影 (Page 6)。作者是否在真实人体 CBCT 投影（非 phantom）上做过任何验证？若有，结果如何？若没有，论文中「feasible for clinical CT applications」(Page 3) 的依据是什么？

**Q2（噪声模型）** 「3% noise」(Page 6) 的具体含义是什么——是投影强度的相对高斯噪声、Poisson 噪声的等效水平，还是其他？是否测试过更高噪声或低剂量条件？论文中未说明。

**Q3（同源性）** 人体数据用 TIGRE 从体数据生成投影，又用同一体数据作为评估 ground truth (Page 6)。生成投影时的几何/物理模型与 NAF 中使用的 forward model（Eq. 2, Page 5）是否完全一致？若一致，PSNR/SSIM 是否会被系统性高估？

**Q4（超参数）** hash encoder 的 L、T、每层特征维度、resolution 范围分别是多少？「same hyper-parameter setting as [14]」(Page 6) 具体指 Instant-NGP 的默认配置还是经过调整的配置？除 chest 外的四个数据集每条 ray 采样多少点？

**Q5（时间公平性）** Fig. 5 中各基线的实现来源是什么？SART 与 ASD-POCS 的迭代停止准则如何设定？「converge to stable results」(Page 9) 的判据是什么？

**Q6（视角数）** Fig. 4 中测试了哪些视角数？「Our methods achieves better results than others under most circumstances」(Page 8) 中「most」之外的情形是哪些？在极少视角（如 10–20 视角）下 NAF 是否仍占优？

**Q7（网络容量）** NAF 的 MLP 为 4 层 32 通道 (Page 5)，参数量远小于 IntraTomo3D 的 6 层 256 通道。作者是否做过容量消融，以区分「hash encoding 的贡献」与「网络更小带来的正则化效应」？

**Q8（hash 冲突）** 论文引用 hash 函数的「many-to-one property ... conforms to the sparsity nature of human organs」(Page 5)。在 512×512×463 的 abdomen 数据上，hash 冲突是否会导致伪影？论文中未说明是否观察到冲突相关伪影。

**Q9（评估指标）** 论文使用 PSNR 与 SSIM (Page 6)。是否考虑过更适合 sparse-view 的指标（如 LPIPS 或针对 artifact 的指标）？论文中未说明。

**Q10（Aorta 的 582 与 50）** Table 1 中 Aorta 行「Number of projections」列为「50 (582)」(Page 6)。请确认：582 是采集总数、50 是实验使用数？论文正文称「This system captures 582 500×500 fluoroscopy projections ... We only use 50 projections for experiments」(Page 6)，与表格一致。但 50 张是从 582 张中如何选取的（等角间隔？连续？）「论文中未说明」。

---

## 4. Missing Experiments

**M1. 真实人体 CBCT 投影上的验证缺失。** 现有真实数据仅 Aorta 硅胶体模一例 (Page 6)。缺少真实患者/志愿者 CBCT 投影实验。

**M2. 噪声鲁棒性扫描缺失。** 仅「3% noise」单一水平 (Page 6)，缺少噪声水平扫描（如 0.5%–10%）与低剂量条件下的表现。

**M3. 视角数扫描的完整报告缺失。** Fig. 4 仅 abdomen 一个数据集 (Page 8)，缺少其余四个数据集在不同视角数下的曲线，也缺少极少视角（<20）的测试。

**M4. 组件消融缺失。** 论文未报告：去掉 hash encoder 改用 frequency encoder 且保持网络规模不变的结果；去掉 skip connection 的结果；改变采样点数 N 的结果；改变 hash 输出维度（32）的结果。这些是支撑 S2/S3 论断所必需的对照。

**M5. 与更多近期 sparse-view CBCT 深度学习方法的对比缺失。** 基线中唯一的 learning-based 方法是作者自行实现的 IntraTomo3D (Page 6)。缺少与其他 self-supervised / INR-based CT 重建方法的对比。

**M6. 多次运行的方差与显著性检验缺失。** Table 2 (Page 7) 未标注是否为单次运行，未给标准差。

**M7. 内存/显存占用报告缺失。** 论文报告了时间 (Fig. 5, Page 9)，但未报告各方法在 abdomen（512×512×463）与 aorta（512×512×510）上的显存占用。论文在 Page 2 提到 iterative methods「require substantial computation time and memory」，但未给出 NAF 自身的内存数据以支持对比。

**M8. 失败案例分析缺失。** 未展示任何 NAF 重建质量明显劣于基线的切片或数据集。

**M9. 几何标定误差敏感性缺失。** CBCT 实际应用中 scanner geometry 存在标定误差，论文使用「the scanner geometry」(Page 3) 模拟 forward projection，但未测试几何参数扰动下的鲁棒性。

---

## 5. 适用边界

**B1. 任务边界：仅针对 sparse-view CBCT，且明确排除其他低剂量路径。**
论文开篇即界定「There are two ways to reduce the dose: decreasing source intensity or projection views [8]. This paper focuses on the latter, i.e., sparse-view CBCT reconstruction」(Page 1)。因此 NAF 的适用性声明不覆盖低强度（low-mA）场景。

**B2. 数据边界：self-supervised，但依赖被测对象自身的投影。**
「requires no external CT scans but the X-ray projections of the interested object」(Page 2)。这意味着每个新对象都需要重新训练（per-subject optimization），而非训练一次即可推理。论文中未说明单对象的训练是否可复用、是否支持增量更新。

**B3. 几何边界：依赖已知的 scanner geometry。**
「NAF then uses the scanner geometry to imitate the attenuation process discretely」(Page 3)。论文中未说明 geometry 的精度要求，也未讨论 geometry 未知或含误差时的行为。

**B4. 物理模型边界：采用 Beer's Law 的离散指数积分（Eq. 2, Page 5），未建模 scatter、beam hardening、partial volume 等效应。**
论文中未说明是否在仿真投影中引入这些效应，也未讨论其对真实数据的影响。**推断**：在真实 CBCT 投影（尤其含金属或高密度骨）上，这一简化可能成为误差来源，但论文未提供证据。

**B5. 尺度边界：采样点数随 CT 尺寸增长。**
「The sampling quantity of each ray depends on the size of CT data. For example, we sample 192 points along each ray for the 128×128×128 chest CT」(Page 6)。**推断**：对 512×512×463 的 abdomen，采样点数需相应增加，训练时间与显存随之上升；但论文中未给出 abdomen/aorta 的具体采样点数与显存数据。

**B6. 时间边界：10–40 分钟量级。**
摘要称「within 10-40 minutes」(Page 3)，正文称「comparable to iterative methods」(Page 3) 且「3× faster than ... IntraTomo3D」(Page 8)。该量级适用于离线重建，论文中未讨论是否满足术中/实时 CBCT 的时间要求。

**B7. 评估边界：PSNR/SSIM 为唯一量化指标。**
「We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM) [25]」(Page 6)。论文中未说明是否评估了下游任务（如分割、病灶检测）的表现，因此「clinical」相关结论缺少任务级证据。

**B8. 结论强度边界：**
论文的「state-of-the-art accuracy」(Page 1, Page 3) 应限定为「在本文所选四种基线、五个数据集、PSNR/SSIM 指标下最优」。论文中未说明该结论是否可推广到其他基线集合、其他解剖部位或其他评价指标。

---

### 附：Table 2 单元格核对说明

Table 2 表头为五个数据集（Chest / Jaw / Foot / Abdomen / Aorta），行标签为五种方法（FDK / SART / ASD-POCS / IntraTomo3D / NAF (Ours)），单元格格式为「PSNR/SSIM」(Page 7)。按此布局，NAF 行对应值为：Chest 33.05/.96、Jaw 34.14/.94、Foot 31.63/.94、Abdomen 34.45/.95、Aorta 30.34/.88 (Page 7)。论文正文给出的交叉验证为「the PSNR value of our method in the abdomen dataset is 3.07 dB higher than that of the second-best method SART」(Page 7)，与表中 34.45 − 31.38 = 3.07 一致，可确认该行未发生转置。Table 1 的列标签为「Dataset name / CT dimension / Scanning method / Scanning range / Number of projections / Detector resolution」(Page 6)，Aorta 行「Number of projections」列为「50 (582)」，与正文「captures 582 ... We only use 50 projections for experiments」(Page 6) 一致。Fig. 4 与 Fig. 5 的具体坐标数值在正文中未给出，需核对原 PDF 图内标注。