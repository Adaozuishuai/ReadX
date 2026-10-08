以下按六个小节给出 5 分钟精读。所有结论均标注证据页；论文未给出的信息一律写「论文中未说明」；属于我的判断处标注「推断」。

## 1. Motivation

本文的出发点是低剂量 CT 的两条降剂量路径——降低源强度或减少投影视角，而本文聚焦后者，即 sparse-view CBCT reconstruction (Page 1)。作者认为该任务困难有两点：视角不足会带来明显 artifacts（传统 CBCT 用数百张投影，sparse-view 输入少 10×），以及 CBCT 因输入维度增加导致空间与计算复杂度远高于 FBCT (Page 1)。作者同时指出，现有 self-supervised 方法多在 FBCT 设定下运行，迁移到 CBCT 时性能与效率下降 (Page 2)。因此本文提出 NAF，用 INR 参数化 attenuation coefficient field，并强调「self-supervised」是指除感兴趣对象的 X-ray projections 外不需要外部 CT 扫描 (Page 2)。作者称该方法在 10–40 分钟内完成重建，与 iterative 方法相当 (Page 3)。

## 2. Existing Problem

作者把已有 CBCT 方法分为 analytical、iterative、learning-based 三类 (Page 2)。Analytical 以 FDK 为代表，在理想情形下结果好，但对 sparse views 这类 ill-posed 问题表现差 (Page 2)。Iterative 方法在 ill-posed 问题上表现好，但需要大量计算时间与内存 (Page 2)。Learning-based 方法中，多数需要大规模数据集训练，并依赖网络「记住 CT 长什么样」，因此难以把一个应用的训练模型迁移到另一个应用 (Page 2)。作者还指出，position encoder 方面常用的 frequency encoder 相当笨重，医学成像实践中其输出尺寸被设为 256 或更大，导致后续网络必须更宽更深，训练数百万参数需数小时，对快速 CT 重建不可接受 (Page 4)。作者进一步论证 dense encoding 对 CBCT 冗余：人体由若干均匀介质组成、自然物体偏好平滑，高频特征仅在边缘附近才必要 (Page 4)。

## 3. Method

NAF 包含四个模块：ray sampling、position encoding、attenuation coefficient prediction、projection synthesis (Page 3)。Ray sampling 采用 stratified sampling，把一条射线分成 N 个等距 bin、每 bin 均匀取一点，并令 N 大于目标 CT 尺寸以保证每条射线经过的每个 grid cell 至少有一个采样点 (Page 4)。Position encoding 使用 hash encoder，用 L 个多分辨率 voxel grid 描述有界空间，每个 grid 配一个大小 T 的可训练 feature lookup table Θ；每个分辨率层级上检测查询点 p 的相邻角点 c、以 hash 方式查其特征 H、再用线性插值 I 生成特征向量，输出为各层级特征向量的拼接 (Page 4–5)。作者称 hash encoder 输出远小于 frequency encoder（本文设定为 32），原因一是 hash 的多对一性质契合人体器官的稀疏性，二是可训练编码器能学会关注相关细节并选择合适频谱 (Page 5)。Attenuation coefficient prediction 用一个简单 MLP Φ：4 个全连接层，前三层 32 通道、层间 ReLU，最后一层 1 个神经元接 sigmoid，并在第二层激活处加入 skip connection 拼接网络输入；作者对比 Zang et al. 使用 6 层 256 通道 MLP，称本文网络小 10× (Page 5)。Attenuation synthesis 依据 Beer's Law，用 I = I0 exp(−Σ μi δi) 数值合成，其中 δi 为相邻点距离 (Page 5)。最终输出为离散 3D 矩阵：构建目标尺寸的 voxel grid，把 voxel 坐标送入训练好的 MLP 预测 attenuation coefficients (Page 5)。

## 4. Loss

损失为 real 与 synthesized projections 之间的 L2 loss，定义为 L(Θ,Φ) = Σ_{r∈B} ‖Ir(r) − Is(r)‖²，其中 B 是 ray batch，Ir 与 Is 分别是射线 r 的 real 与 synthesized projections (Page 5)。训练过程中同时更新 hash encoder Θ 与 attenuation coefficient network Φ (Page 5)。优化使用 Adam，学习率从 1×10⁻³ 起步并降至 1×10⁻⁴，每次迭代 batch size 为 2048 rays (Page 6)。每条射线的采样点数取决于 CT 数据尺寸，例如对 128×128×128 的 chest CT 每条射线采样 192 个点；hash encoder 沿用 [14] 的同一套超参数设置，更多超参数细节见 supplementary material (Page 6)。论文正文未给出该 supplementary material 的内容，论文中未说明其具体超参数取值。

## 5. Experiments

数据方面，实验覆盖五个数据集：human organ 的 chest、jaw、foot、abdomen 与一个 phantom (Page 6)。Chest 来自 LIDC-IDRI，其余三个来自 Open Scientific Visualization Datasets；由于这些数据集只提供体数据 CT，作者用 TIGRE 生成投影，在 180° 范围内采集 50 个投影并加入 3% 噪声，训练用这些投影、评估用原始体数据 CT (Page 6)。Phantom 为用 GE C-arm Medical System 扫描的硅胶主动脉 phantom，该系统采集 582 张 500×500 fluoroscopy 投影，primary angle 从 −103° 到 93°、secondary angle 为 0°，并以内置算法生成 512×512×510 CT 作为 ground truth，实验中只用 50 个投影 (Page 6)。Table 1 列出各数据集的 CT dimension、scanning method、scanning range、projection 数与 detector resolution：Chest 128×128×128、TIGRE、0°∼180°、50、256×256；Jaw 256×256×256、TIGRE、0°∼180°、50、512×512；Foot 256×256×256、TIGRE、0°∼180°、50、512×512；Abdomen 512×512×463、TIGRE、0°∼180°、50、1024×1024；Aorta 512×512×510、GE C-arm、−103°∼93°、50 (582)、500×500 (Page 6)。基线为 FDK、SART、ASD-POCS，以及作者实现的 CBCT 版 IntraTomo（称 IntraTomo3D）作为 frequency-encoding 深度学习方法 (Page 6)。评价指标为 PSNR 与 SSIM，越高表示重建越准确 (Page 6)。

Table 2 的表头为五个数据集（Chest / Jaw / Foot / Abdomen / Aorta），行标签为五种方法，单元格为 PSNR/SSIM (Page 7)。按此布局报告：FDK 22.89/.78、28.59/.78、23.92/.58、22.39/.59、12.11/.21；SART 32.12/.95、32.67/.93、30.13/.93、31.38/.92、27.31/.77；ASD-POCS 29.78/.92、32.78/.93、28.67/.89、30.34/.91、27.30/.76；IntraTomo3D 31.94/.95、31.95/.91、31.43/.91、30.43/.90、29.38/.82；NAF (Ours) 33.05/.96、34.14/.94、31.63/.94、34.45/.95、30.34/.88 (Page 7)。作者举例称 abdomen 上本文 PSNR 比次优方法 SART 高 3.07 dB (Page 7)。定性上，FDK 恢复出带明显 artifacts 的低质量模型，SART 抑制噪声但丢失细节，ASD-POCS 因 TV 正则鼓励去除高频而严重模糊，IntraTomo3D 结果干净但介质间边缘略模糊，作者认为这说明 frequency encoder 未能教会网络关注边缘；NAF 细节最多、边缘最清晰、artifacts 最少 (Page 7–8)。Fig. 3 显示 NAF 在重建 CT 体的所有 slice 上优于其他方法 (Page 8)。Fig. 4 显示性能随输入视角数增加而上升，本文方法在多数情形下更好 (Page 8)。时间上，IntraTomo3D 训练需一个多小时，NAF 运行时间与 iterative 方法相近，且比 IntraTomo3D 快 3× (Page 8)。需要说明：以上「更好」均为论文自述结论，本文未报告统计显著性检验，论文中未说明误差棒或重复实验次数。

## 6. Conclusion

作者总结 NAF 是一个快速的 self-supervised learning-based sparse-view CBCT 重建方案：训练一个全连接深度网络，输入 3D 空间坐标、输出该位置的 attenuation coefficient，通过基于预测 attenuation coefficients 衰减入射 X-ray 来合成投影，并以最小化投影误差更新网络 (Page 8)。作者重申 frequency encoding 在 tomographic reconstruction 任务上计算效率不高，改用 learning-based 的 hash encoding 提取特征 (Page 8–9)。实验结论为在 human organ 与 phantom 数据集上显著优于其他基线，且计算时间合理偏短 (Page 9)。作者列出的贡献包括：无需外部数据集与结构先验（除被摄对象的投影）、达到 state-of-the-art 精度且计算时间相对短、代码将公开 (Page 3)。

补充审稿视角（推断）：本文的核心可复现前提是 scanner geometry 已知并用于离散模拟衰减过程 (Page 3)，以及 hash encoder 超参数沿用 [14]、其余超参数放在未随正文提供的 supplementary material 中 (Page 6)；因此仅凭正文无法完整复现训练配置。此外，human organ 的实验输入是 TIGRE 合成投影而非真实扫描 (Page 6)，只有 Aorta 为真实 C-arm 采集 (Page 6)，这一差异在解读跨数据集指标对比时需要保留。