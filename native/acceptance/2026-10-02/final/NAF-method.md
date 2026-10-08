以下按你要求的维度逐项解析。所有结论均标注原文位置；论文未给出的信息明确写「论文中未说明」。公式转写一律标「转写待核对」，因为文本抽取可能丢失运算符/上下标。

---

## 1. 输入域（Input domain）

**论文事实：**
- NAF 的输入是「encoded spatial coordinate (x,y,z)」，即 3D 空间坐标经位置编码后的特征 (Page 2, Sec 1)。
- MLP 的输入是「an encoded spatial coordinate (x,y,z)」，输出是「the attenuation coefficient µ at that location」(Page 2, Sec 1)。
- 射线采样点坐标「are then sent to the position encoding module」(Page 4, Sec 2.2, Ray sampling)。
- 最终输出阶段：「pass the voxel coordinates to the trained MLP to predict the corresponding attenuation coefficients」(Page 5, Sec 2.3)。

**推断：** 输入域是一个有界立方体空间（bounded field / cubical space），因为文中提到「rays intersect the cube」以及「We represent the bounded field with a simple MLP Φ」(Page 4–5, Sec 2.2)。但立方体的具体坐标范围/归一化方式论文中未说明。

---

## 2. 输入 → 模块 → 输出的数据流

**论文事实（Page 3, Sec 2.1, Fig. 1）：** NAF 由四个模块组成：
1. ray sampling
2. position encoding
3. attenuation coefficient prediction
4. projections synthesis

数据流（Page 3–5, Sec 2.1–2.2）：
- **Ray sampling**：沿 X-ray 路径均匀采样点 → 输出采样点坐标 (Page 4, Sec 2.2)。
- **Position encoding**：把 3D 坐标映射到更高维空间 → 输出编码特征 (Page 4, Sec 2.2)。
- **Attenuation coefficient prediction**：MLP 消费编码信息 → 输出该位置 attenuation coefficient µ (Page 4–5, Sec 2.2)。
- **Attenuation synthesis**：按 Beer's Law 沿路径衰减入射 X-ray → 合成投影 (Page 5, Sec 2.2)。

**训练流：** 比较 real 与 synthesized projections，最小化 L2 loss，更新 hash encoder Θ 与网络 Φ (Page 5, Sec 2.3, Eq. 3)。

**输出流：** 优化后，构建 desired size 的 voxel grid，查询 MLP 得到 attenuation coefficients，恢复 CT model (Page 5, Sec 2.3)。

---

## 3. 模块各自作用

**Ray sampling（Page 4, Sec 2.2）：**
- 每个投影像素值来自一条穿过立方体空间并被介质衰减的 X-ray。
- 在射线与立方体相交部分采样 N 个点。
- 采用 stratified sampling：把一条射线分成 N 个等距 bin，每个 bin 均匀采一个点。
- 设 N 大于期望 CT size，确保每条 X-ray 经过的每个 grid cell 至少分配一个采样点。

**Position encoding（Page 4–5, Sec 2.2）：**
- 目的：缓解 neural network 因「spectral bias」偏好学习低频细节的问题 (Page 4, Sec 2.2)。
- 论文对比两种编码：
  - **frequency encoder**（Mildenhall et al. [13]）：把空间坐标 p ∈ R³ 分解为 L 组不同频率的正弦分量；论文称其为 dense encoder，输出尺寸常设为 256 或更大，导致后续网络更宽更深、训练耗时 (Page 4, Sec 2.2)。
  - **hash encoder**（Müller et al. [14]）：learning-based sparse encoding；论文采用它，输出更小（32 in our setting），后续网络更紧凑 (Page 5, Sec 2.2)。

**Attenuation coefficient prediction（Page 5, Sec 2.2）：**
- 用简单 MLP Φ 表示 bounded field，输入编码坐标，输出 µ。
- 结构：4 个 fully-connected layers；前 3 层 32-channel wide，层间 ReLU；最后一层 1 个 neuron + sigmoid activation。
- 含一个 skip connection，把网络输入 concatenate 到第二层 activation。
- 对比：Zang et al. [28] 用 6-layer 256-channel MLP；论文称自己的网络「10× smaller」。

**Attenuation synthesis（Page 5, Sec 2.2）：**
- 依据 Beer's Law，X-ray 穿过物质时强度按 attenuation coefficients 的指数积分衰减。
- 数值合成见 Eq. 2。

---

## 4. Skip / residual / fusion

**论文事实：**
- 唯一明确提到的 skip connection 在 attenuation coefficient prediction 模块：「A skip connection is included to concatenate the network input to the second layer's activation.」(Page 5, Sec 2.2)。
- 即：网络输入（编码后的坐标）被 concatenate 到第二层的 activation 上。

**论文中未说明：** 该 skip 是加法 residual 还是 concatenation 之外的其他融合方式——文中明确写的是 concatenate，未提及 residual addition。hash encoder 内部的多分辨率特征融合方式是「concatenation of feature vectors at all resolution levels」(Page 5, Sec 2.2)，这是编码器输出层面的拼接，不是网络 skip。

**推断：** 这里的「fusion」应理解为 concatenation-based skip，而非 residual add；但论文未使用「residual」一词描述该连接。

---

## 5. 2D → 3D 映射

**论文事实：**
- CBCT 用 2D projections 构建 3D model (Page 1, Sec 1)。
- NAF 把 attenuation coefficient field 参数化为 INR：网络把 spatial coordinates 映射到 attenuation coefficients (Page 2, Sec 1)。
- 训练时用 scanner geometry 离散模拟衰减过程，通过比较 real 与 synthesized projections 学习 CT shapes (Page 3, Sec 2.1)。
- 最终输出：「The final output is formulated as a discrete 3D matrix. We build a voxel grid with the desired size and pass the voxel coordinates to the trained MLP to predict the corresponding attenuation coefficients.」(Page 5, Sec 2.3)。

**推断：** 2D→3D 的桥梁是「沿射线采样 + 体渲染式合成投影」：3D 场被查询得到 µ，再沿射线积分成 2D 投影；监督信号来自 2D 投影，梯度回传到 3D 场参数。这是论文描述的机制，但论文未用「differentiable rendering」这一术语（该术语出现在对他人工作的描述中，Page 2, Sec 1 提到 learning-based methods「make optimization process differentiable」）。

---

## 6. Source–detector–ray–projection matrix 几何

**论文事实：**
- CBCT scanner 发出 cone-shaped X-ray beams，在等角间隔捕获 2D projections (Page 1, Sec 1)。
- X-ray source 绕物体旋转并发出 cone-shaped beams；2D panel 在等角间隔检测 projections (Page 3, Sec 2.1)。
- NAF 使用 scanner geometry 离散模拟衰减过程 (Page 3, Sec 2.1)。
- Ray sampling 基于 scanner geometry 沿 X-ray paths 采样 (Page 4, Sec 2.2)。
- 数据生成：TIGRE toolbox 中捕获 50 projections，范围 180° (Page 6, Sec 3.1)。
- Phantom：GE C-arm 系统捕获 582 张 500×500 fluoroscopy projections，position primary angle 从 -103° 到 93°，position secondary angle 为 0° (Page 6, Sec 3.1)。

**论文中未说明：**
- 具体的 projection matrix 形式、source-detector distance、detector pixel spacing、cone angle、几何标定参数等均未在正文给出。
- 论文提到「More details of hyper-parameters can be found in the supplementary material」(Page 6, Sec 3.1)，但当前材料未包含 supplementary，故这些几何细节「论文中未说明（当前材料未找到）」。

**推断：** 几何模型应是标准的 cone-beam 参数化（source 位置 + detector panel + 射线方向），但论文未给出显式公式或矩阵。

---

## 7. 关键公式逐符号与直觉解释

### Eq. 1 — Hash encoder（Page 4, Sec 2.2）

原文转写（**转写待核对**）：
```
MH(p; Θ) = [I(H1), ··· , I(HL)]^T ,  H = {c | h(c) = ( c_j π_j ) mod T}
```
- `MH(p; Θ)`：hash encoder 输出，输入点 p 与可训练查找表参数 Θ。
- `p`：查询点（3D 空间坐标）。
- `Θ`：size 为 T 的 trainable feature lookup table，每个 voxel grid 一个 (Page 4, Sec 2.2)。
- `L`：multiresolution voxel grids 的层数（分辨率级数）。
- `H1, ..., HL`：各分辨率级下查到的特征。
- `I(·)`：linear interpolation。
- `c`：neighbouring corners（查询点 p 的邻域角点）。
- `h(c)`：hash function。
- `T`：查找表大小。
- `c_j π_j`：**转写待核对**——文本抽取可能丢失运算符，π_j 的确切含义（是否为某素数/置换相关量）无法从当前材料确认；论文说「More details of hash function and its symbols can be found in [14]」(Page 5, Sec 2.2)。

直觉（Page 4–5, Sec 2.2）：用 L 个多分辨率 voxel grid 描述有界空间；每个 grid 分配一个 size T 的可训练查找表；对查询点 p，检测邻域角点 c，用 hash 方式查其特征 H，再线性插值 I 生成特征向量；输出是所有分辨率级特征向量的拼接。论文强调 hash function 的 many-to-one 性质契合人体器官的稀疏性，且可训练编码器能学习关注相关细节、选择合适频谱。

### Eq. 2 — Attenuation synthesis（Page 5, Sec 2.2）

原文转写（**转写待核对**）：
```
I = I0 exp(− Σ_{i=1}^{N} µ_i δ_i)
```
- `I`：穿过物质后的 X-ray 强度。
- `I0`：initial intensity（入射强度）。
- `N`：沿射线的采样点数。
- `µ_i`：第 i 个采样点的 attenuation coefficient。
- `δ_i = ‖p_{i+1} − p_i‖`：相邻采样点之间的距离 (Page 5, Sec 2.2)。

直觉：Beer's Law——X-ray 穿过物质时强度按 attenuation coefficients 沿路径的指数积分衰减；数值上用离散采样点求和近似积分。

### Eq. 3 — Loss（Page 5, Sec 2.3）

原文转写（**转写待核对**）：
```
L(Θ, Φ) = Σ_{r∈B} ‖I_r(r) − I_s(r)‖²
```
- `L(Θ, Φ)`：loss，同时优化 hash encoder 参数 Θ 与 attenuation coefficient network 参数 Φ。
- `B`：ray batch。
- `r`：batch 中的一条 ray。
- `I_r(r)`：real projection for ray r。
- `I_s(r)`：synthesized projection for ray r。

直觉：在 ray batch 上最小化 real 与 synthesized projections 的 L2 误差；论文明确「We update both hash encoder Θ and attenuation coefficient network Φ during the training process」(Page 5, Sec 2.3)。

---

## 8. 代码伪代码思路

**论文事实支撑的流程（Page 3–5, Sec 2.1–2.3）：**

```
# 初始化
hash_encoder Θ (size T lookup table, L levels)
MLP Φ (4 FC layers: 3×32-channel + ReLU, last 1 neuron + sigmoid, skip concat input→2nd layer activation)
Adam optimizer, lr 1e-3 → 1e-4, batch size 2048 rays (Page 6, Sec 3.1)

# 每次迭代
for each ray batch B:
    for each ray r in B:
        sample N points along ray (stratified, N > CT size)   # Page 4
        encode each point: f = hash_encoder(p; Θ)              # Eq.1, Page 4
        predict µ_i = Φ(f) for each point                      # Page 5
        synthesize I_s(r) = I0 * exp(-Σ µ_i δ_i)               # Eq.2, Page 5
    loss = Σ_{r∈B} ||I_r(r) - I_s(r)||²                        # Eq.3, Page 5
    update Θ and Φ via gradient descent

# 输出
build voxel grid of desired size
query trained MLP at voxel coordinates → attenuation coefficients
restore CT model                                                # Page 5, Sec 2.3
```

**论文中未说明：** 具体代码实现细节（如 hash 冲突处理、优化器 epsilon、warm-up、学习率调度曲线等）在正文未给出；论文称「More details of hyper-parameters can be found in the supplementary material」(Page 6, Sec 3.1)，当前材料未包含。

---

## 9. 关于 FDK / SART 的说明

**论文事实：**
- FDK [7] 被选为 analytical methods 的代表 (Page 6, Sec 3.1)。
- SART [2] 是 robust iterative reconstruction algorithm (Page 6, Sec 3.1)。
- ASD-POCS [20] 是另一个带 total-variation regularizer 的 iterative method (Page 6, Sec 3.1)。
- IntraTomo3D [28] 是 frequency-encoding deep learning method 的 CBCT 变体 (Page 6, Sec 3.1)。

**明确：** FDK、SART、ASD-POCS 均为经典非神经网络方法，不应标为神经网络；只有 IntraTomo3D 与 NAF 是 learning-based。

---

## 10. 复现所依赖的前提（论文明确给出的）

- 实现框架：PyTorch (Page 6, Sec 3.1)。
- 优化器：Adam，lr 从 1×10⁻³ 降到 1×10⁻⁴ (Page 6, Sec 3.1)。
- Batch size：2048 rays/iteration (Page 6, Sec 3.1)。
- 每条射线采样数取决于 CT 大小；例：128×128×128 chest CT 采样 192 点 (Page 6, Sec 3.1)。
- hash encoder 超参与 [14] 相同 (Page 6, Sec 3.1)。
- 硬件：单张 RTX 3090 GPU (Page 6, Sec 3.1)。
- 数据：5 个数据集，human organ（chest/jaw/foot/abdomen）+ phantom（aorta）(Page 6, Sec 3.1, Table 1)。
- Human organ 投影由 TIGRE 生成：50 projections，3% noise，180° 范围 (Page 6, Sec 3.1)。
- Phantom：仅用 50 projections (Page 6, Sec 3.1)。

**论文中未说明：** 训练迭代次数、收敛判据、hash encoder 的具体 T/L 值（正文只说与 [14] 相同）、supplementary 中的其余超参。

---

## 11. 表格数据（Table 2，Page 7）

**表头辨认：** 列为 5 个数据集（Chest, Jaw, Foot, Abdomen, Aorta）；行为 5 种方法（FDK, SART, ASD-POCS, IntraTomo3D, NAF (Ours)）。单元格格式为 PSNR/SSIM。

**逐行报告（Page 7, Table 2）：**
- FDK [7]：Chest 22.89/.78；Jaw 28.59/.78；Foot 23.92/.58；Abdomen 22.39/.59；Aorta 12.11/.21
- SART [2]：Chest 32.12/.95；Jaw 32.67/.93；Foot 30.13/.93；Abdomen 31.38/.92；Aorta 27.31/.77
- ASD-POCS [20]：Chest 29.78/.92；Jaw 32.78/.93；Foot 28.67/.89；Abdomen 30.34/.91；Aorta 27.30/.76
- IntraTomo3D [28]：Chest 31.94/.95；Jaw 31.95/.91；Foot 31.43/.91；Abdomen 30.43/.90；Aorta 29.38/.82
- NAF (Ours)：Chest 33.05/.96；Jaw 34.14/.94；Foot 31.63/.94；Abdomen 34.45/.95；Aorta 30.34/.88

**论文对 Table 2 的陈述：** 「the PSNR value of our method in the abdomen dataset is 3.07 dB higher than that of the second-best method SART」(Page 7, Sec 3.2)。核对：34.45 − 31.38 = 3.07，与原文一致。

**注意：** 论文未说明 PSNR/SSIM 的计算细节（如是否在特定 slice 上、是否用 mask），当前材料未找到。

---

## 12. Table 1（Page 6）

**表头辨认：** 列为 Dataset name | CT dimension | Scanning method | Scanning range | Number of projections | Detector resolution。

**逐行报告（Page 6, Table 1）：**
- Chest [4]：128×128×128；TIGRE [5]；0° | ∼180°；50；256×256
- Jaw [12]：256×256×256；TIGRE [5]；0° | ∼180°；50；512×512
- Foot [12]：256×256×256；TIGRE [5]；0° | ∼180°；50；512×512
- Abdomen [12]：512×512×463；TIGRE [5]；0° | ∼180°；50；1024×1024
- Aorta：512×512×510；GE C-arm；−103° | ∼93°；50 (582)；500×500

**说明：** Aorta 行 Number of projections 单元格为「50 (582)」，即实验用 50，原始采集 582 (Page 6, Sec 3.1)。

---

## 13. 需要特别标注的边界

- 论文摘要与引言使用「novel」「state-of-the-art」等表述 (Page 1, Page 3)，这是作者自述；本解析不据此判定方法「首次提出」或「更好」。
- 论文称 NAF「quantitatively and qualitatively outperforms existing solutions」(Page 2, Sec 1)，这是作者结论；指标更高不等于方法在所有场景更优，且复现依赖上述前提。
- 所有公式均为「转写待核对」，尤其 Eq. 1 中 `c_j π_j` 的运算符与符号含义无法从当前材料确认，需核对原 PDF。
- 图 1–5 的具体内容（如 Fig. 1 中模块细节、Fig. 3/4/5 的曲线数值）当前材料仅给出图注，图内信息未抽取，故不报告具体数值。