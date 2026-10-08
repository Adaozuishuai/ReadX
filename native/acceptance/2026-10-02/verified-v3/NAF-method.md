# NAF 方法与公式解析

以下严格按论文原文（Page 1–11）逐项解析。凡论文未给出的信息，均标注「论文中未说明」；推断部分标注「推断」。

---

## 1. 输入域（Input Domain）

**论文事实：**
- 输入是「an encoded spatial coordinate (x,y,z)」，输出是「the attenuation coefficient µ at that location」(Page 2)。
- 即网络把 3D 空间坐标映射为衰减系数，构成 Implicit Neural Representation (INR) (Page 2)。
- 采样点坐标来自「the parts where rays intersect the cube」，即射线与立方体空间的交点区间 (Page 4, Sec 2.2)。

**推断：** 输入域是 CBCT 重建体积所对应的有界立方体空间（bounded field，Page 5, Sec 2.2 "We represent the bounded field"）。论文未给出该立方体的具体坐标范围或归一化方式。

---

## 2. 输入 → 模块 → 输出的数据流

**论文事实（Page 3, Sec 2.1）：** NAF 由四个模块组成，顺序为：
1. ray sampling
2. position encoding
3. attenuation coefficient prediction
4. projections synthesis

**数据流（Page 4, Sec 2.2）：**
- ray sampling：沿 X-ray 路径采样点 → 坐标送入 position encoding。
- position encoding：把 3D 坐标映射到更高维空间 → 送入 MLP。
- attenuation coefficient prediction：MLP 输出该位置的 µ。
- attenuation synthesis：按 Beer's Law 沿路径合成投影强度。

**输出（Page 5, Sec 2.3）：** 训练完成后，构建 desired size 的 voxel grid，把 voxel 坐标送入训练好的 MLP 预测对应 µ，得到离散 3D 矩阵（CT model）。

**训练信号（Page 5, Sec 2.3）：** 最小化 real 与 synthesized projections 之间的 L2 loss；同时更新 hash encoder Θ 与 attenuation coefficient network Φ。

---

## 3. 各模块作用

### 3.1 Ray sampling（Page 4, Sec 2.2）
- 每个投影像素值来自一条穿过立方体空间并被介质衰减的 X-ray。
- 采用 stratified sampling [13]：把一条 ray 分成 N 个等距 bin，每个 bin 均匀采样一个点。
- 设定 N 大于期望 CT size，以保证每条 X-ray 穿过的每个 grid cell 至少分配到一个 sample。
- **论文未说明：** N 的具体取值规则（仅举例：128×128×128 chest CT 采样 192 点，Page 6, Sec 3.1）。

### 3.2 Position encoding（Page 4–5, Sec 2.2）
- 目的：缓解 neural network 的 "spectral bias"（偏好低频），把 3D 坐标映射到高维空间。
- 对比对象：frequency encoder [13]（Mildenhall et al.），把坐标分解为 L 组不同频率的正弦分量。
- 论文采用 hash encoder [14]（Müller et al.），一种 learning-based sparse encoding。
- 论文给出的 hash encoder 公式 (Eq. 1, Page 4)：

  MH(p; Θ) = [I(H₁), ···, I(H_L)]ᵀ,  H = {c | h(c) = (c_j π_j) mod T}

  逐符号：
  - p：查询点坐标
  - Θ：可训练 feature lookup table，大小 T
  - L：多分辨率 voxel grid 层数
  - c：邻域角点（neighbouring corners）
  - h：hash function [23]
  - I：线性插值
  - H：查表得到的特征
  - 输出为各分辨率层特征向量的拼接

- 论文称 hash encoder 输出远小于 frequency encoder（"32 in our setting"，Page 5），并给出两点理由：hash 的 many-to-one 性质契合人体器官稀疏性；可训练 encoder 能学习聚焦相关细节并选择合适频谱 (Page 5)。

### 3.3 Attenuation coefficient prediction（Page 5, Sec 2.2）
- 用简单 MLP Φ，输入 encoded spatial coordinates，输出 µ。
- 结构（Fig. 1(c)）：4 个 fully-connected layers；前 3 层 32-channel wide，层间 ReLU；最后一层 1 个 neuron + sigmoid activation。
- 含 skip connection：把 network input 拼接到第二层 activation。
- 对比：Zang et al. [28] 用 6-layer 256-channel MLP；论文称自己的网络 "10× smaller" (Page 5)。

### 3.4 Attenuation synthesis（Page 5, Sec 2.2）
- 依据 Beer's Law，用数值方式合成衰减过程，公式 (Eq. 2, Page 5)：

  I = I₀ exp(− Σ_{i=1}^{N} µ_i δ_i)

  逐符号：
  - I₀：initial intensity
  - µ_i：第 i 个采样点的衰减系数
  - δ_i = ‖p_{i+1} − p_i‖：相邻采样点距离
  - N：每条 ray 的采样点数

---

## 4. Skip / Residual / Fusion

**论文事实：**
- 论文明确提到的 skip connection 只有一处：attenuation coefficient network 中「A skip connection is included to concatenate the network input to the second layer's activation」(Page 5, Sec 2.2)。
- 即：把 MLP 的输入（encoded coordinates）拼接到第二层的 activation 上。

**论文未说明：** 该 skip 的具体拼接维度、是否用加法或 concat 之外的融合方式、是否存在其他 residual 连接。论文未使用 "residual" 或 "fusion" 术语描述该结构。

**推断：** 这是 concatenation 形式的 skip（论文用词 "concatenate"），非 residual addition。

---

## 5. 2D → 3D 映射

**论文事实：**
- CBCT 用 2D projections 构建 3D model（Page 1–2）。
- NAF 通过比较 real 与 synthesized projections 学习 CT 形状（Page 3, Sec 2.1）。
- 最终 3D 输出：构建 desired size 的 voxel grid，把 voxel 坐标送入训练好的 MLP 预测 µ，恢复 CT model（Page 5, Sec 2.3）。

**推断：** 2D→3D 的桥梁是「沿 ray 采样 + 体渲染式积分（Eq. 2）+ 投影误差反传」，即通过可微的投影合成把 2D 投影监督信号传回 3D 隐式场。论文未显式使用 "2D→3D mapping" 这一表述。

---

## 6. Source–Detector–Ray–Projection Matrix 几何

**论文事实：**
- CBCT scanner 发出 cone-shaped X-ray beams，在等角间隔捕获 2D projections（Page 1）。
- X-ray source 绕物体旋转，2D panel 在等角间隔检测投影（Page 3, Sec 2.1）。
- NAF「uses the scanner geometry to imitate the attenuation process discretely」(Page 3, Sec 2.1)。
- Ray sampling 基于 scanner geometry，沿 X-ray paths 采样（Page 4, Sec 2.2）。
- 数据生成：TIGRE [5] 中在 180° 范围内捕获 50 projections，含 3% noise（Page 6, Sec 3.1）。
- Phantom：GE C-arm，582 张 500×500 fluoroscopy projections，primary angle −103°~93°，secondary angle 0°（Page 6, Sec 3.1）。

**论文未说明：** source-detector 距离、探测器像素间距、投影矩阵（projection matrix）的具体形式、cone-beam 几何参数、坐标变换细节。论文未给出 projection matrix 的数学表达。

**推断：** 几何建模依赖 TIGRE 或扫描仪内置几何，NAF 本身不显式参数化 projection matrix，而是用 scanner geometry 生成 ray。

---

## 7. 关键公式汇总

| 公式 | 位置 | 作用 |
|---|---|---|
| MH(p; Θ) = [I(H₁),···,I(H_L)]ᵀ, H={c\|h(c)=(c_j π_j) mod T} | Eq. 1, Page 4 | hash encoder 编码 |
| I = I₀ exp(−Σ µ_i δ_i) | Eq. 2, Page 5 | Beer's Law 投影合成 |
| L(Θ,Φ) = Σ_{r∈B} ‖I_r(r) − I_s(r)‖² | Eq. 3, Page 5 | L2 训练损失 |

**Eq. 3 逐符号（Page 5, Sec 2.3）：**
- B：ray batch
- I_r：real projection for ray r
- I_s：synthesized projection for ray r
- Θ：hash encoder 参数
- Φ：attenuation coefficient network 参数

---

## 8. 代码伪代码思路（基于论文描述）

**论文事实支撑的流程（Page 3–5）：**

```
# 初始化
Θ = hash encoder 参数 (T 大小 lookup table, L 层)
Φ = MLP (4 层, 前 3 层 32-channel + ReLU, 末层 1 neuron + sigmoid, skip: input→第2层)

# 训练循环
for iteration in training:
    B = 采样 ray batch (batch size 2048 rays, Page 6)
    for each ray r in B:
        points = stratified_sample(N 点, 沿 ray 与 cube 交点)   # Page 4
        for each point p:
            feat = MH(p; Θ)                                    # Eq.1
            µ = Φ(feat)                                        # MLP
        I_s(r) = I₀ * exp(-Σ µ_i * δ_i)                        # Eq.2
    L = Σ_{r∈B} ||I_r(r) - I_s(r)||²                           # Eq.3
    更新 Θ, Φ (Adam, lr 1e-3 → 1e-4)                           # Page 6

# 输出
构建 desired size voxel grid
for each voxel coord:
    µ = Φ(MH(coord; Θ))
得到离散 3D CT matrix                                          # Page 5, Sec 2.3
```

**论文未说明：** 具体代码实现细节、数据加载、TIGRE 几何参数传递方式、hash table 更新策略细节（论文称 "same hyper-parameter setting as [14]"，Page 6）。

---

## 9. 关于 FDK / SART 的说明

**论文事实：**
- FDK [7] 是 analytical method 的代表（Page 2, Page 6）。
- SART [2] 是 robust iterative reconstruction algorithm（Page 6）。
- ASD-POCS [20] 是带 total-variation regularizer 的 iterative method（Page 6）。
- IntraTomo3D [28] 是 frequency-encoding deep learning method（Page 6）。

以上四者中，FDK、SART、ASD-POCS 均为经典非神经网络方法；仅 IntraTomo3D 属深度学习类。论文未将 FDK/SART 标为神经网络。

---

## 10. 复现所依赖的前提（论文明确给出）

- 实现框架：PyTorch [17]（Page 6）。
- 优化器：Adam，lr 1×10⁻³ 起步，降至 1×10⁻⁴（Page 6）。
- Batch size：2048 rays/iteration（Page 6）。
- 采样点数：依 CT 尺寸而定，例：128×128×128 chest CT 用 192 点/ray（Page 6）。
- Hash encoder 超参：同 [14]（Page 6）。
- 硬件：单张 RTX 3090 GPU（Page 6）。
- 数据生成：TIGRE [5]，50 projections，3% noise，180° 范围（Page 6）。
- 评价指标：PSNR (dB) 与 SSIM [25]（Page 6）。

**论文未说明：** hash encoder 的 T、L 具体数值（仅说输出 32，Page 5）；MLP 各层具体维度以外的细节；训练迭代次数；收敛判据。