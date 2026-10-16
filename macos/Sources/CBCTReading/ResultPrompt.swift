import Foundation

extension Store {
    static var resultsPrompt: String {
        """
        抽取结果表及有证据的分析，输出完整 JSON，不输出计算差值。差值由程序计算。
        字段 F={"k":"具体字段名","v":"摘录支持的事实或论文未说明","page":物理页码或null,"excerpt":"同一页连续逐字摘录或null"}。
        结构：{"tables":[{"id":"table2","primaryMethodID":"能由原文确认的本文方法行id，否则null","caption":F,"header":F,"protocol":F,"columns":[{"id":"abdomen_psnr","label":"原表列标签/数据集","metric":"原文指标名","unit":"原文单位或论文未说明","context":F}],"rows":[{"id":"naf","method":"原表方法名","evidence":F,"cells":[{"columnID":"abdomen_psnr","valueText":"原表该格数字字符串","uncertaintyText":null}]}]}],"stability":[D],"ablation":[D],"generalization":[D],"efficiency":[D],"statistics":[F],"missing":["尚需核对的具体事项"]}。
        D={"evidence":F,"interpretation":"AI解读：有条件的解释，勿超出实验范围","tableID":"对应 tables 的 id 或null","visualID":"所提供结果图的 id 或null"}。每条 D 必须且只能绑定一张表或一张实际提供的图；表格 id 使用原文表号如 table2。每张结构化结果表至少给一条 D，说明关键指标变化、基线对照和结论边界；解读将在对应图表后紧邻展示，禁止另写集中解读章节。图的实际读数以已校验的图内 observations 为依据，不能从正文猜图中曲线。
        尽量覆盖原文中的主结果、实际消融和效率等结果表，每个数据集的 PSNR、SSIM 各为独立列；不得挑选部分方法伪装完整主表。非结果表（例如数据集尺寸表）留作配置资料，不伪装成方法性能表。遇到某个表头、方法行或单元格无法可靠读取时，保留其余有证据的内容，只省略无法核验的对象，并在 missing 中逐项写明表号、页码与原因；禁止猜数或静默省略整张表。
        caption 摘录表号标题；header 摘录表头含数据集与指标；protocol 用原文摘录支持同表 views、数据与采集/评测设置。未知严格用 v=论文未说明,page=null,excerpt=null。模型不得推断未给出的数据范围、归一化或单位。
        表头字段特别约束：header.v 直接复制 header.excerpt，不写方法行名、参考文献号或方法数量；表头与方法行分开。例如 header.excerpt="Chest Jaw Foot Abdomen Aorta" 时，header.v 也仅为"Chest Jaw Foot Abdomen Aorta"，不能加 FDK [7]、IntraTomo3D [28] 等行标签。row.evidence.v 仅为 row.method（逐字方法行标签），不重述各列归属。
        column.context 只引用该列所属数据集的表头原文，v 与 excerpt 直接复制 header.excerpt，不重组数据集名与指标名；指标名称依据表题 caption 或 Metrics 正文，禁止将不连续的表头与指标定义拼成一个 excerpt。每列另有可选 unitEvidence:F，用于单位在其他段落/页报告的情况。unit 若填写 dB、%、s、ms、GB 等，必须在 context 或 unitEvidence 的摘录中直接出现。请优先检索 Metrics/Evaluation 正文，不要仅因表头省略单位就声称论文未说明。无法找到才填论文未说明。SSIM 无单位时也填论文未说明，勿把常识当论文报告。
        每行 evidence.excerpt 是包含完整方法标签和可读数值的逐字方法行，不要拼接不连续表头；v 只需报告方法名及该摘录直接支持的数字。某格无法读清时从该行 cells 中省略该格，并在 missing 中写出表号、方法名、列名和页码；不要给它填 0、猜测值或挪用相邻列。原文可能用 .958 省略前导零；valueText 必须保留原记法，例如“.958”，不得改成“0.958”。valueText 只含一个数字，不含单位或 ±。如有误差项，uncertaintyText 保存逐字数字；否则 null。columnID 与列 id 精确相同，不得错配行列。
        primaryMethodID 必须为该表已抽取的方法行 id，只有原文明确作者方法身份时才填写；不能仅把最好的一行当作本文方法，未确认时填 null 并在 missing 标记。本文方法相对各基线的逐指标 Δ 由程序直接显示，不在 interpretation 中猜算差值。不得编造表格、函数、统计检验或 p 值。statistics 仅复制作者报告的检验或显著措辞，v 明示“作者措辞/作者报告”，不能把作者 significantly 的措辞解释成已执行统计检验；没有统计材料返回空数组。不要自己计算统计显著性。
        stability 是跨已列数据集/指标的一致性解读；不等于跨随机种子统计稳定性。ablation 只用实际消融；没有消融返回空数组并注明。generalization 不得仅凭多数据集声称同分布或跨域；逐病例自监督优化不等同于固定模型跨域迁移，协议无法确认则明确待核对。efficiency 使用作者原称呼，原文仅称重建时间就写重建耗时，不改称训练/推理时间。每条都须有可定位依据；不能用未知字段支撑肯定判断。
        F.v 只含 excerpt 直接支持的事实，不加入未被该摘录支持的缺失判断、数据集名称、指标或同分布判断。未知/缺失列表均标注“当前抽取未定位，需进一步核对”，不得把抽取未定位写成作者未进行某实验或全论文没有某信息。
        caption/header/statistics/protocol 与 D.evidence 的 v 优先直接复制 excerpt，避免添加原摘录没有的数字和缺失结论；AI解释另放 interpretation。unitEvidence.v 仅复制原文单位。
        证据均用单个物理页连续摘录，至少8个非空白字符。字段v中所有数字需被摘录支持；截图布局不清时 tables 返回空数组并说明需核对 PDF，不能猜测单元格。
        """
    }
}
