**Problem**
稀疏视角 CBCT 重建需从数十张投影（比传统 CBCT 少约 10×）恢复三维衰减系数场，视图不足会带来明显伪影，且 CBCT 的空间与计算复杂度远高于 FBCT (Page 1)。现有 learning-based 方法多依赖大量外部数据训练，自监督方法又多在 FBCT 设定下运行，迁移到 CBCT 时性能与效率下降 (Page 2)。

**Key Idea**
将衰减系数场表示为以 3D 空间坐标 (x,y,z) 为输入、输出该点衰减系数 µ 的连续函数，由全连接 MLP 参数化，并用自监督方式最小化真实投影与合成投影之间的误差 (Page 2)。投影合成沿射线采样点预测衰减系数，再按 Beer's Law 对入射 X 射线做指数衰减积分 (Page 5)。

**Innovation**
采用基于学习的 hash encoding（多分辨率体素网格 + 可训练特征查找表 + 线性插值）替代常用频域编码，利用人体器官的平滑性与稀疏性，输出维度更小（本文设为 32），使后续网络更紧凑 (Page 4, Page 5)。网络为 4 层全连接，前三层 32 通道、末层单神经元接 sigmoid，并含 skip connection，比 Zang et al. 的 6 层 256 通道 MLP 小 10× (Page 5)。

**Result**
在五个数据集（chest、jaw、foot、abdomen、aorta）上，NAF 的 PSNR/SSIM 均高于 FDK、SART、ASD-POCS、IntraTomo3D；例如 abdomen 上 PSNR 比次优的 SART 高 3.07 dB (Page 7)。训练可在 10–40 分钟内完成详细 CT 重建，与迭代方法耗时相近，并比频域编码的 IntraTomo3D 快 3× (Page 3, Page 8)。

**Limitation**
论文中未说明（原文未设专门的 limitation 讨论章节；仅在 related work 中指出自监督方法在 CBCT 场景下性能与效率下降，未对 NAF 自身局限作出说明）(Page 2)。