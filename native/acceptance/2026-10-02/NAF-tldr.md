**Problem**：稀疏视角 CBCT 重建（仅数十张投影）面临严重伪影，且 CBCT 的空间与计算复杂度远高于 FBCT；现有 learning-based 方法多依赖大量外部数据，自监督方法又多在 FBCT 设定下运行，迁移到 CBCT 时性能与效率下降 (Page 1, Page 2)。

**Key Idea**：将衰减系数场表示为 3D 空间坐标的连续函数（INR），用全连接 MLP 预测每点衰减系数 μ，按 Beer 定律沿射线离散合成投影，并以真实与合成投影间的 L2 损失自监督优化，无需外部训练数据 (Page 2, Page 3, Page 5)。

**Innovation**：用 learning-based 的 hash encoder 替代常用 frequency-domain encoder，理由是人体器官具有平滑性与稀疏性、稠密编码冗余；hash encoder 输出维度更小（本文设为 32），使后续网络更紧凑（4 层、32 通道，比对比方法小 10×）(Page 4, Page 5)。

**Result**：在五个 human organ 与 phantom 数据集上 PSNR/SSIM 均高于 FDK、SART、ASD-POCS 与 IntraTomo3D，例如 abdomen 上 PSNR 比次优的 SART 高 3.07 dB；重建耗时 10–40 分钟，与迭代方法相当，约为 IntraTomo3D 的 3× 快 (Page 3, Page 7, Page 8)。

**Limitation**：论文中未说明——原文未设专门的 limitation 章节，也未讨论失败情形或方法适用边界；仅可注意到其评估依赖 TIGRE 生成的仿真投影（50 视角、3% 噪声）与单一 phantom 扫描，且超参数细节被放在补充材料中（正文未给出）(Page 6)。