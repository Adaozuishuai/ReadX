**Problem**  
稀疏视角 CBCT 重建需从数十张投影恢复三维衰减系数场，视图不足导致明显伪影，且 CBCT 的空间与计算复杂度远高于 FBCT (Page 1)。现有自监督方法多在 FBCT 设定下运行，迁移到 CBCT 时性能与效率下降 (Page 2)。

**Key Idea**  
将衰减系数场表示为以三维空间坐标为输入、以该点衰减系数 µ 为输出的连续函数（MLP），用扫描几何离散合成投影，并以真实与合成投影间的 L2 误差做自监督优化 (Page 2, Page 5)。采用基于学习的 hash encoding 替代常用频域编码，以捕捉高频细节 (Page 2, Page 4)。

**Innovation**  
提出 NAF：无需外部数据集或结构先验、仅用被扫描对象的投影即可自监督训练 (Page 3)。用 hash encoder（输出 32 维）替代频域编码，使后续网络更紧凑（4 层、前三层 32 通道，比 Zang et al. 的 6 层 256 通道 MLP 小 10×）(Page 5)。

**Result**  
在五个人体器官与体模数据集上，NAF 的 PSNR/SSIM 均高于 FDK、SART、ASD-POCS、IntraTomo3D；例如 abdomen 数据集 PSNR 比次优的 SART 高 3.07 dB (Page 7)。重建耗时 10–40 分钟，与迭代方法相当，且比 IntraTomo3D 快 3× (Page 3, Page 8)。

**Limitation**  
论文未设专门的局限性讨论章节；仅可确认其自监督设定依赖被扫描对象自身的投影，且训练时间仍以分钟至小时计（10–40 分钟，IntraTomo3D 超过一小时）(Page 3, Page 8)。其他潜在限制论文中未说明。