# 复现准备：NAF: Neural Attenuation Fields for Sparse-View CBCT Reconstruction

论文：2209.14540
分析版本：10efbbf9dcde4716a6b96d85c54d52d8ec7fd58933edcd1782782b6869eedcb0

范围：论文材料分析；未自动检查代码/数据可用性或运行训练。AI 分析与行动需核对；未知指当前材料未找到。人工已核对不等于复现成功。

模型：deepseek-flash · 生成：2026-10-02T10:01:28Z · 解析：evidence-v3

## 资源 · 数据 / 代码 / 权重

### 代码公开声明

[论文报告 · 尚需人工核对] Code available at https://github.com/Ruyi-Zha/naf_cbct.

PDF Page 1 · 原文：Code available at https://github.com/Ruyi-Zha/naf_cbct.

AI 分析 / 推断：AI 推断：论文声称提供代码链接，但当前材料未包含仓库内容，无法确认代码是否包含训练脚本、hash encoder 实现或数据生成脚本；资源公开性尚需在线核实。

建议行动：在线访问该 GitHub 仓库，核对是否包含 NAF 训练/推理代码、hash encoder 实现、TIGRE 投影生成脚本与超参配置；若缺失，记录缺失模块。

人工核对：已核对
记录：已核对 PDF Page 1 的代码链接声明；仅确认论文文字，尚未访问仓库或运行代码。
更新：2026-10-02T10:03:40Z

### 数据集来源

[论文报告 · 尚需人工核对] We conduct experiments on five datasets containing human organ and phantom data.

PDF Page 6 · 原文：We conduct experiments on five datasets containing human organ and phantom data. Details are listed in Table 1.

AI 分析 / 推断：AI 推断：论文列出五个数据集（Chest、Jaw、Foot、Abdomen、Aorta），但当前材料未说明各数据集的具体下载路径、预处理脚本或划分方式；复现需先确认数据获取与预处理流程。

建议行动：核对 Table 1 与正文，确认每个数据集的公开来源（LIDC-IDRI、Open Scientific Visualization Datasets、GE C-arm 采集）及是否提供预处理脚本；若未提供，需自行实现 TIGRE 投影生成并记录参数。

人工核对：待核对
记录：尚无记录

## 环境 · 依赖 / 特殊算子

### 深度学习框架

[论文报告 · 尚需人工核对] Our proposed method is implemented in PyTorch [17].

PDF Page 6 · 原文：Our proposed method is implemented in PyTorch [17].

AI 分析 / 推断：AI 推断：论文仅说明使用 PyTorch，未给出具体版本号；不同 PyTorch 版本可能影响 hash encoder 自定义算子、CUDA 扩展与训练稳定性，需核对官方仓库的依赖声明。

建议行动：核对官方仓库的 requirements.txt 或 environment.yml，记录 PyTorch 版本、CUDA 版本及是否包含自定义 CUDA 算子；若未提供，需在固定版本下进行小规模复现实验。

人工核对：待核对
记录：尚无记录

### CUDA 加速

[论文报告 · 尚需人工核对] All methods use CUDA [15] to accelerate the computation process.

PDF Page 8 · 原文：All methods use CUDA [15] to accelerate the computation process.

AI 分析 / 推断：AI 推断：论文说明使用 CUDA 加速，但未给出 CUDA 版本、cuDNN 版本或特殊算子编译依赖；hash encoder 可能依赖自定义 CUDA 实现，需核对仓库中的编译说明。

建议行动：核对官方仓库的安装说明与 CUDA 扩展编译脚本，确认是否需要 nvcc、CUDA toolkit 版本及 GPU 架构编译选项；在目标环境进行编译测试。

人工核对：待核对
记录：尚无记录

## 训练成本 · 时间 / 显存

### 训练时间

[论文报告 · 尚需人工核对] method can reconstruct a detailed CT model within 10-40 minutes, which is comparable to iterative methods.

PDF Page 3 · 原文：method can reconstruct a detailed CT model within 10-40 minutes, which is comparable to iterative methods.

AI 分析 / 推断：AI 推断：论文报告训练时间为 10–40 分钟，但未说明该时间对应的具体数据集、分辨率、迭代次数或硬件配置；复现时需在相同条件下测量，不能直接套用。

建议行动：在固定 views、几何、分辨率、batch size 下运行官方代码，记录实际训练时间；与论文报告的 10–40 分钟对比，记录差异及可能原因。

人工核对：待核对
记录：尚无记录

### GPU 型号

[论文报告 · 尚需人工核对] All experiments are conducted on a single RTX 3090 GPU.

PDF Page 6 · 原文：All experiments are conducted on a single RTX 3090 GPU.

AI 分析 / 推断：AI 推断：论文仅报告使用单张 RTX 3090，未报告实际峰值显存占用；显存需求取决于 batch size、采样点数、hash 表大小与网络宽度，需单独 profiling。

建议行动：在固定配置下使用 nvidia-smi 或 PyTorch 显存监控记录峰值显存；若论文未报告，则作为未知项记录，不按 GPU 型号推断。

人工核对：待核对
记录：尚无记录

## 关键缺失 · 几何 / 预处理 / 参数

### 训练终止条件

[当前材料未找到] 论文未说明

AI 分析 / 推断：AI 推断：当前材料未找到迭代次数、收敛判据或早停策略；终止条件直接影响训练时间与重建质量，需核对补充材料或官方仓库。

建议行动：核对补充材料、官方仓库训练脚本与配置文件，记录迭代次数、学习率调度与停止条件；若未提供，需在固定 views 与分辨率下进行消融实验确定合理终止条件。

人工核对：待核对
记录：尚无记录

### 投影生成几何参数

[当前材料未找到] 论文未说明

AI 分析 / 推断：AI 推断：论文说明使用 TIGRE 生成投影，但当前材料未给出源到探测器距离、探测器像素尺寸、旋转中心等几何参数；这些参数直接影响投影合成与重建精度，需核对补充材料或官方仓库。

建议行动：核对补充材料与官方仓库中的 TIGRE 配置脚本，记录源到探测器距离、探测器分辨率、旋转角度范围与采样间隔；若未提供，需根据 Table 1 中的扫描范围与探测器分辨率进行合理设置并记录。

人工核对：待核对
记录：尚无记录

## 风险 · 实现 / 评测协议

### hash encoder 实现一致性

[论文报告 · 尚需人工核对] We use the same hyper-parameter setting for hash encoder as [14].

PDF Page 6 · 原文：We use the same hyper-parameter setting for hash encoder as [14].

AI 分析 / 推断：AI 推断：论文声称沿用 Instant NGP 的 hash encoder 超参，但未列出具体数值（如 hash 表大小、分辨率层数、特征维度）；若官方仓库实现与论文描述不一致，可能导致重建质量差异。

建议行动：核对官方仓库中 hash encoder 的实现与超参配置，与 Instant NGP 原论文对比；在固定数据集上运行并记录 PSNR/SSIM，验证是否与论文报告一致。

人工核对：待核对
记录：尚无记录

### 评测协议一致性

[论文报告 · 尚需人工核对] We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM) [25].

PDF Page 6 · 原文：We evaluate five methods quantitatively in terms of peak signal-to-noise ratio (PNSR) and structural similarity (SSIM) [25].

AI 分析 / 推断：AI 推断：论文报告 PSNR/SSIM，但未说明计算时的数据范围（如 HU 值归一化方式）、是否使用掩膜或裁剪区域；不同评测协议可能导致指标不可比。

建议行动：核对官方仓库中的评测脚本，确认 PSNR/SSIM 的计算细节（数据范围、归一化、掩膜）；在相同协议下复现 Table 2 的指标，记录差异。

人工核对：待核对
记录：尚无记录
