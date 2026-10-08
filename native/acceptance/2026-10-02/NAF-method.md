以下按你要求的维度逐项解析。所有结论均标注原文位置；论文未给出的信息一律写「论文中未说明」；「论文事实」与「推断」分开标注。

---

## 1. 输入域（Input Domain）

**论文事实：**
- 输入是 CBCT 扫描得到的 2D X-ray projections（投影图），以及 scanner geometry（扫描几何）(Page 1, Abstract; Page 3, Sec 2.1)。
- 方法为 self-supervised：不需要外部 CT 训练数据，只需要「the X-ray projections of the interested object」(Page 2, Sec 1)。
- 待重建对象被表示为一个 bounded field（有界场），即 attenuation coefficient field（衰减系数场）(Page 2, Sec 1; Page 5, Sec 2.2)。
- 网络输入是 encoded spatial coordinate (x, y, z)，输出是该位置的 attenuation coefficient µ (Page 2, Sec 1; Page 5, Sec 2.2)。

**推断：**
- 输入域本质上是「射线路径上的连续 3D 空间坐标」+「对应投影像素强度」，二者通过 scanner geometry 关联。论文未显式用「输入域」这一术语，此为对 Sec 2.1–2.2 的归纳。

---

## 2. 输入 → 模块 → 输出的数据流

**论文事实（Page 3, Sec 2.1, Fig. 1）：**
NAF 由四个模块组成：
1. ray sampling（射线采样）
2. position encoding（位置编码）
3. attenuation coefficient prediction（衰减系数预测）
4. projection synthesis（投影合成）

数据流（Page 3–5, Sec 2.1–2.2）：
- 基于 scanner geometry，沿 X-ray paths 均匀采样点 (Page 3, Sec 2.1; Page 4, Sec 2.2)。
- position encoder 将空间坐标编码为高维特征 (Page 4, Sec 2.2)。
- MLP 消费编码信息，预测 attenuation coefficients (Page 4, Sec 2.2)。
- 根据路径上预测的衰减系数对 incident X-rays 做衰减，合成 projections (Page 4, Sec 2.2)。
- 优化：最小化 real 与 synthesized projections 之间的 L2 loss (Page 5, Sec 2.3, Eq. 3)。
- 输出：训练完成后，构建 desired size 的 voxel grid，将 voxel 坐标送入训练好的 MLP 预测对应衰减系数，得到离散 3D 矩阵 (Page 5, Sec 2.3)。

**推断：**
- 整体是「坐标 → 特征 → µ → 投影 → 与真实投影比对 → 反传更新 encoder 与 MLP」的闭环。论文未用「闭环」措辞，此为对 Sec 2.1–2.3 的归纳。

---

## 3. 各模块作用

**论文事实：**

**(a) Ray sampling（Page 4, Sec 2.2）**
- 每个投影像素值来自一条穿过立方体空间、被内部介质衰减的 X-ray。
- 在射线与立方体相交的部分采样 N 个点。
- 采用 stratified sampling：将射线分成 N 个等间距 bin，每个 bin 均匀采样一个点。
- 令 N 大于期望 CT size，以保证每条 X-ray 经过的每个 grid cell 至少分配到一个 sample。
- 采样点坐标送入 position encoding 模块。

**(b) Position encoding（Page 4–5, Sec 2.2）**
- 目的：缓解 neural network 的「spectral bias」，即网络偏好学习低频细节 (Page 4, Sec 2.2)。
- 对比对象：frequency encoder（Mildenhall et al. [13]），将 p ∈ R³ 分解为 L 组不同频率的正弦分量 (Page 4, Sec 2.2)。
- 论文采用 hash encoder [14]，一种 learning-based sparse encoding (Page 4, Sec 2.2)。
- 论文给出的 hash encoder 公式 (Page 4, Eq. 1)：
  M_H(p; Θ) = [I(H₁), ···, I(H_L)]ᵀ, H = {c | h(c) = (⊕ⱼ cⱼ πⱼ) mod T}
- 描述：用 L 个 multiresolution voxel grids 描述有界空间；每个 voxel grid 分配一个 size 为 T 的 trainable feature lookup table Θ (Page 4, Sec 2.2)。
- 每个分辨率层级：1) 检测查询点 p 的 neighbouring corners c；2) 以 hash function 方式 h[23] 查找对应特征 H；3) 用 linear interpolation I 生成 feature vector (Page 5, Sec 2.2)。
- 输出为所有分辨率层级 feature vector 的拼接 (Page 5, Sec 2.2)。
- 论文称 hash encoder 输出更小（32 in our setting），且特征质量有竞争力 (Page 5, Sec 2.2)。

**(c) Attenuation coefficient prediction（Page 5, Sec 2.2）**
- 用简单 MLP Φ 表示有界场，输入 encoded spatial coordinates，输出该位置 attenuation coefficient µ。
- 网络结构：4 个 fully-connected layers；前 3 层 32-channel wide，层间 ReLU；最后一层 1 个 neuron，后接 sigmoid activation。
- 含一个 skip connection，将 network input 拼接到第二层 activation。
- 对比：Zang et al. [28] 用 6-layer 256-channel MLP；论文称其网络小 10×。

**(d) Attenuation synthesis（Page 5, Sec 2.2）**
- 依据 Beer's Law，X-ray 穿过物质时强度按路径上衰减系数的指数积分衰减。
- 数值合成公式 (Page 5, Eq. 2)：I = I₀ exp(−Σᵢ₌₁ᴺ µᵢ δᵢ)
- I₀ 为初始强度，δᵢ = ‖pᵢ₊₁ − pᵢ‖ 为相邻点距离。

---

## 4. Skip / Residual / Fusion

**论文事实：**
- MLP 中包含一个 skip connection，将 network input 拼接到第二层 activation (Page 5, Sec 2.2)。
- hash encoder 的输出是各分辨率层级 feature vector 的 concatenation（拼接融合）(Page 5, Sec 2.2)。
- 论文未使用「residual」一词描述任何模块。

**论文中未说明：**
- skip connection 的具体拼接维度、是否含线性变换、是否与 residual addition 混用。
- 各分辨率层级 feature vector 的具体维度与拼接后总维度（仅给出 hash encoder 输出为 32）。

**推断：**
- 该 skip connection 属于 concatenation 型 skip（类似 U-Net/NeRF 的输入拼接），而非 residual addition。依据是原文用词「concatenate」而非「add」(Page 5, Sec 2.2)。

---

## 5. 2D → 3D 映射

**论文事实：**
- CBCT 依赖 2D projections 构建 3D model；FBCT 则堆叠由 1D projections 恢复的 2D slices (Page 1–2, Sec 1)。
- NAF 将 attenuation coefficient field 参数化为 INR，用 MLP 将 3D 空间坐标映射到 µ (Page 2, Sec 1; Page 5, Sec 2.2)。
- 最终输出为离散 3D matrix：构建 desired size 的 voxel grid，将 voxel 坐标送入训练好的 MLP 预测衰减系数 (Page 5, Sec 2.3)。

**推断：**
- 2D→3D 的桥梁是「沿射线采样 + Beer's Law 合成投影 + 与真实 2D 投影比对」这一可微过程；3D 信息通过优化被隐式编码进 MLP 与 hash table。论文未用「隐式编码」描述该机制，此为对 Sec 2.2–2.3 的归纳。

---

## 6. Source–Detector–Ray–Projection Matrix 几何

**论文事实：**
- CBCT scanner 发出 cone-shaped X-ray beams，在等角间隔捕获 2D projections (Page 1, Sec 1; Page 3, Sec 2.1)。
- X-ray source 绕物体旋转，2D panel 在等角间隔检测投影 (Page 3, Sec 2.1)。
- NAF 使用 scanner geometry 离散地模拟衰减过程 (Page 3, Sec 2.1)。
- 采样基于 scanner geometry，沿 X-ray paths 进行 (Page 3, Sec 2.1; Page 4, Sec 2.2)。
- 实验几何参数（Page 6, Table 1）：
  - Chest/Jaw/Foot/Abdomen：TIGRE [5]，扫描范围 0°∼180°，50 projections，detector resolution 分别为 256×256、512×512、512×512、1024×1024。
  - Aorta：GE C-arm，−103°∼93°，50 (582) projections，detector resolution 500×500；position primary angle −103° to 93°，position secondary angle 0° (Page 6, Sec 3.1)。
- 投影生成：TIGRE 中捕获 50 projections，180° 范围内含 3% noise (Page 6, Sec 3.1)。

**论文中未说明：**
- source–detector distance、source–object distance、voxel spacing、projection matrix 的具体形式与数值。
- 是否显式构造 projection matrix，或使用 TIGRE 的几何接口。
- 射线与立方体求交的具体算法。

**推断：**
- 「scanner geometry」在实现中很可能以 TIGRE 的几何参数形式提供，用于确定射线起点/方向与采样区间。论文未给出该细节，此为推断。

---

## 7. 关键公式逐符号与直觉解释

### Eq. 1（Page 4, Sec 2.2）
M_H(p; Θ) = [I(H₁), ···, I(H_L)]ᵀ, H = {c | h(c) = (⊕ⱼ cⱼ πⱼ) mod T}

- M_H：hash encoder 输出。
- p：查询的 3D 空间坐标。
- Θ：trainable feature lookup table，size 为 T。
- L：multiresolution voxel grids 的层数。
- H_l：第 l 层查找到的特征。
- I(·)：linear interpolation。
- c：查询点 p 的 neighbouring corners。
- h(c)：hash function [23]。
- cⱼ：corner 坐标分量。
- πⱼ：论文未说明其确切定义（原文仅写 πⱼ，未给符号表；「More details of hash function and its symbols can be found in [14]」）。
- T：lookup table size。
- mod T：取模，实现 many-to-one 映射。
- ⊕：论文未说明该符号定义（原文写作 (⊕ⱼ cⱼ πⱼ) mod T，未给符号表）。

**直觉（推断）：**
- 用多分辨率体素网格 + 可训练特征表 + 哈希取模，把连续坐标映射到稀疏可学习特征；many-to-one 哈希契合人体器官的稀疏性 (Page 5, Sec 2.2)。

### Eq. 2（Page 5, Sec 2.2）
I = I₀ exp(−Σᵢ₌₁ᴺ µᵢ δᵢ)

- I：穿过物质后的 X-ray 强度。
- I₀：初始强度。
- N：每条射线采样点数。
- µᵢ：第 i 个采样点的 attenuation coefficient。
- δᵢ = ‖pᵢ₊₁ − pᵢ‖：相邻采样点距离。
- 直觉：Beer's Law 的离散化，路径上衰减系数越大/路径越长，透射强度越低。

### Eq. 3（Page 5, Sec 2.3）
L(Θ, Φ) = Σ_{r∈B} ‖I_r(r) − I_s(r)‖²

- L：loss function。
- Θ：hash encoder 参数。
- Φ：attenuation coefficient network 参数。
- B：ray batch。
- r：batch 中的一条 ray。
- I_r(r)：real projection。
- I_s(r)：synthesized projection。
- 直觉：在 ray batch 上最小化真实与合成投影的 L2 误差；训练时同时更新 Θ 与 Φ (Page 5, Sec 2.3)。

---

## 8. 代码伪代码思路

**论文事实（可支撑的步骤）：**
- 采样：将射线分成 N 个等间距 bin，每 bin 均匀采样一点 (Page 4, Sec 2.2)。
- 编码：hash encoder，L 层多分辨率网格，每层查表 + 线性插值，输出拼接 (Page 4–5, Sec 2.2)。
- 预测：4 层 MLP，前 3 层 32 通道 + ReLU，末层 1 神经元 + sigmoid，输入拼接到第二层 activation (Page 5, Sec 2.2)。
- 合成：Eq. 2 (Page 5, Sec 2.2)。
- 损失：Eq. 3 (Page 5, Sec 2.3)。
- 优化：Adam，lr 从 1×10⁻³ 降到 1×10⁻⁴，batch size 2048 rays/iteration (Page 6, Sec 3.1)。
- 采样数：依 CT 尺寸而定，如 128×128×128 chest CT 每条射线采样 192 点 (Page 6, Sec 3.1)。
- 输出：构建 desired size voxel grid，查询 MLP 得 3D 矩阵 (Page 5, Sec 2.3)。

**伪代码（推断，基于上述事实）：**
```
for iteration in training:
    rays = sample_ray_batch(B=2048)              # Page 6, Sec 3.1
    pts  = stratified_sample(rays, N)             # Page 4, Sec 2.2
    feat = hash_encoder(pts; Θ)                   # Eq.1, Page 4
    mu   = MLP(feat; Φ)                           # Page 5, Sec 2.2
    Is   = I0 * exp(-sum(mu * delta))             # Eq.2, Page 5
    loss = sum(||Ir - Is||^2)                     # Eq.3, Page 5
    update Θ, Φ via Adam(lr 1e-3 → 1e-4)          # Page 6, Sec 3.1

# inference
voxel_grid = build_grid(desired_size)             # Page 5, Sec 2.3
CT = MLP(hash_encoder(voxel_coords; Θ); Φ)        # Page 5, Sec 2.3
```

**论文中未说明：**
- 具体代码实现细节（如 hash table 更新方式、梯度如何流经插值、是否使用 CUDA 自定义 kernel）。
- 训练迭代次数、收敛判据。
- 学习率 step down 的具体时机。

---

## 9. 关于 FDK / SART 的说明

**论文事实：**
- FDK [7] 是 analytical methods 的代表，通过求解 Radon transform 及其逆估计衰减系数 (Page 2, Sec 1)。
- SART [2] 是 robust iterative reconstruction algorithm (Page 6, Sec 3.1)。
- ASD-POCS [20] 是带 total-variation regularizer 的 iterative method (Page 6, Sec 3.1)。
- IntraTomo3D 是 frequency-encoding deep learning method 的 CBCT 变体 (Page 6, Sec 3.1)。

以上四者中，FDK、SART、ASD-POCS 均为经典非神经网络方法；IntraTomo3D 为深度学习类方法。论文未将 FDK/SART 标为神经网络，本解析亦不如此标注。

---

## 10. 复现所依赖的前提（论文明确给出者）

- 需 scanner geometry (Page 3, Sec 2.1)。
- 需真实 projections 作为监督信号 (Page 2, Sec 1; Page 5, Sec 2.3)。
- 需 TIGRE [5] 生成 human organ 投影（50 projections, 3% noise, 180°）(Page 6, Sec 3.1)。
- 需 GE C-arm 采集 phantom 数据（582 projections，仅用 50）(Page 6, Sec 3.1)。
- 需单张 RTX 3090 GPU (Page 6, Sec 3.1)。
- hash encoder 超参与 [14] 相同 (Page 6, Sec 3.1)。
- 更多超参在 supplementary material（本论文正文未含）(Page 6, Sec 3.1)。

**论文中未说明：**
- supplementary material 的具体内容。
- 代码仓库中是否包含完整几何配置。

---

## 11. 需谨慎的表述

- 论文自述「novel and fast self-supervised solution」(Page 1, Abstract) 与「state-of-the-art accuracy」(Page 1, Abstract; Page 3, Sec 1)。本解析不据此判定方法「首次提出」或「优于所有方法」；仅记录论文原文表述。
- 论文报告 NAF 在 Table 2 中 PSNR/SSIM 多数最高 (Page 7, Table 2)，但指标更高不等于方法在所有维度更优；论文亦指出 IntraTomo3D「produces clean results」但边缘略模糊 (Page 7, Sec 3.2)。
- 论文称 NAF 比 IntraTomo3D 快 3×，与 iterative methods 耗时相近 (Page 8, Sec 3.2, Fig. 5)。