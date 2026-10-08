以下按六个小节给出 5 分钟精读。全文结论均标注证据页；论文未给出的信息一律注明「论文中未说明」；属于我的判断处标注「推断」。

## 1. Motivation

本文面向 sparse-view CBCT reconstruction，目标是从数十张投影中恢复 volumetric attenuation coefficient field (Page 1)。作者指出降低辐射剂量有两条路径：降低源强度或减少投影视角，本文聚焦后者 (Page 1)。其技术动机来自计算机视觉中的 Implicit Neural Representation (INR)：把有界场景参数化为神经网络，将空间坐标映射到 occupancy、color 等量，并借助 position encoder 学习高频细节 (Page 2)。据此作者提出 NAF，把 attenuation coefficient field 表示为 INR，并用自监督方式模仿 X 射线衰减过程 (Page 2)。作者强调「self-supervised」是指除感兴趣对象的 X 射线投影外，不需要任何外部 CT 扫描 (Page 2)。

## 2. Existing Problem

作者把已有 CBCT 方法分为 analytical、iterative 与 learning-based 三类 (Page 2)。Analytical 方法（如 FDK）在理想情形下结果良好，但对 sparse views 这类 ill-posed 问题处理很差 (Page 2)。Iterative 方法在 ill-posed 问题上表现好，但需要大量计算时间与内存 (Page 2)。Learning-based 方法中，多数工作需要大规模数据集训练，且依赖网络「记住 CT 长什么样」，导致一个应用的训练模型难以迁移到另一个应用 (Page 2)。已有的 self-supervised 方法则在 FBCT 设定下运行，受网络容量与内存限制，迁移到 CBCT 时性能与效率都会下降 (Page 2)。此外，常用 frequency encoder 输出维度大（医学影像实践中常设为 256 或更大），迫使后续网络更宽更深，训练数百万参数需数小时，对快速 CT 重建不可接受 (Page 4)。

## 3. Method

NAF 包含四个模块：ray sampling、position encoding、attenuation coefficient prediction、projection synthesis (Page 3)。Ray sampling 采用 stratified sampling，把每条射线分成 N 个等距 bin 并在每个 bin 内均匀采样一点，N 大于目标 CT 尺寸以保证射线经过的每个 grid cell 至少有一个采样点 (Page 4)。Position encoding 采用 hash encoder，用 L 个多分辨率 voxel grid 描述有界空间，每个 grid 配一个大小为 T 的可训练 feature lookup table，通过查表与线性插值生成特征向量并在各分辨率层级拼接 (Page 4–5)。作者选择 hash encoder 的理由是：人体由若干均匀介质组成、天然物体偏好平滑，因此 dense 的 frequency encoding 存在冗余；hash 函数的 many-to-one 性质契合器官稀疏性，且可训练编码器能自行选择合适频谱 (Page 4–5)。Attenuation coefficient prediction 使用 4 层全连接 MLP，前三层 32 通道并带 ReLU，最后一层单神经元接 sigmoid，并在第二层激活处加入 skip connection 拼接网络输入；作者称该网络比 Zang et al. 的 6 层 256 通道 MLP 小 10 倍 (Page 5)。Attenuation synthesis 依据 Beer's Law，用 I = I0 exp(−Σ μi δi) 数值合成衰减，其中 δi 为相邻采样点距离 (Page 5)。

## 4. Loss

损失函数为真实投影与合成投影之间的 L2 loss，定义为 L(Θ,Φ) = Σ_{r∈B} ‖Ir(r) − Is(r)‖²，其中 B 是 ray batch，Ir 与 Is 分别为射线 r 的真实与合成投影 (Page 5)。训练过程中 hash encoder 参数 Θ 与 attenuation coefficient network 参数 Φ 同时更新 (Page 5)。优化使用 Adam，学习率从 1×10⁻³ 起步并降至 1×10⁻⁴，每次迭代 batch size 为 2048 条射线 (Page 6)。每条射线的采样点数取决于 CT 数据尺寸，例如对 128×128×128 的 chest CT 每条射线采样 192 个点；hash encoder 超参数与 Müller et al. 保持一致，更多超参数见补充材料 (Page 6)。最终输出被组织为离散 3D 矩阵：构建目标尺寸的 voxel grid，将 voxel 坐标送入训练好的 MLP 预测对应 attenuation coefficient，从而恢复 CT 模型 (Page 5)。

## 5. Experiments

数据方面使用五个数据集：human organ 部分含 chest、jaw、foot、abdomen，其中 chest 来自 LIDC-IDRI，其余来自 Open Scientific Visualization Datasets；由于这些数据集只提供体数据 CT，作者用 TIGRE 在 180° 范围内生成 50 张带 3% 噪声的投影，并用原始体数据评估 (Page 6)。Phantom 部分用 GE C-arm Medical System 扫描 silicon aortic phantom，该系统采集 582 张 500×500 透视投影（primary angle 从 −103° 到 93°，secondary angle 为 0°），内置算法生成 512×512×510 的 CT 作为 ground truth，实验只使用其中 50 张投影 (Page 6)。Baselines 包括 FDK、SART、ASD-POCS，以及作者实现的 IntraTomo 的 CBCT 变体 IntraTomo3D（frequency-encoding 深度学习方法）(Page 6)。评价指标为 PSNR 与 SSIM，越高表示重建越准确 (Page 6)。结果显示 NAF 在两类数据集上 PSNR/SSIM 均为最高，例如 abdomen 上 PSNR 比次优的 SART 高 3.07 dB (Page 7)；定性上 FDK 伪影明显、SART 抑制噪声但丢失细节、ASD-POCS 因 TV 正则严重模糊、IntraTomo3D 结果干净但介质边缘略模糊，而 NAF 细节最多、边缘最清晰、伪影最少 (Page 7–8)。时间上 NAF 与 iterative 方法耗时相近，比 IntraTomo3D 快 3 倍，后者训练需超过一小时 (Page 8)；作者称可在 10–40 分钟内重建出细节丰富的 CT 模型 (Page 3)。需注意：Table 2 的数值在原文中排版错位，各行与各方法的对应关系在论文中未明确说明，我无法据此逐项核对具体数字（推断：表格版式在 PDF 转换中被打乱）。

## 6. Conclusion

作者总结 NAF 是一种快速、自监督、基于学习的 sparse-view CBCT 重建方案：训练一个全连接深度网络，输入 3D 空间坐标、输出该位置的 attenuation coefficient，通过最小化投影误差更新网络 (Page 8)。作者认为 frequency encoding 在 tomographic reconstruction 任务中计算效率不高，因此改用 learning-based 的 hash encoding 提取特征 (Page 8–9)。在 human organ 与 phantom 数据集上的实验表明该方法显著优于各 baseline，且计算时间合理偏短 (Page 9)。作者列出的贡献为：提出快速自监督 sparse-view CBCT 方法，除受试者投影外不需要外部数据集或结构先验；取得 state-of-the-art 精度且耗时相对较短，使其对临床 CT 应用可行；代码将公开 (Page 3)。需要指出的是，论文中未说明该方法在更低视角数或更高噪声下的失效边界，也未给出与临床剂量指标的定量关联；此外「state-of-the-art」为作者自述，本文的对比仅限其选定的四个 baseline（推断：结论的适用范围受该 baseline 集合限制）。