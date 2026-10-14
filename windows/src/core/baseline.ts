// Baseline 百科与方法卡片（PRD 4.7），移植自 macOS BaselineLibrary.swift。
//
// 卡片内容是**领域常识**，不是某篇论文的抽取结果，因此必须显式标注来源类型；
// 凡不确定的字段写 null，UI 显示「待核对」，不补造。
// 与「某篇论文提到了哪些基线」（ExperimentExtraction.baselines）是两件事。

export type BaselineKind = '解析重建' | '迭代重建' | '深度学习' | '隐式表示' | '混合 / 插件式';

export function isNeuralNetwork(kind: BaselineKind): boolean {
  return kind === '深度学习' || kind === '隐式表示' || kind === '混合 / 插件式';
}

export interface BaselineCard {
  id: string;
  name: string;
  aliases: string[];
  kind: BaselineKind;
  origin: string | null;
  task: string;
  inputOutput: string;
  coreIdea: string;
  codeURL: string | null;
  commonDatasets: string[];
  applicableSettings: string;
  knownLimitations: string | null;
  source: '领域常识' | '待核对';
}

/** 别名匹配键：小写、去 ²→2、去空格与 - _。 */
export function baselineMatchKey(raw: string): string {
  return (raw ?? '').toLowerCase().replace(/²/g, '2').replace(/ /g, '').replace(/-/g, '').replace(/_/g, '');
}

const C = (
  id: string, name: string, aliases: string[], kind: BaselineKind, origin: string | null,
  task: string, inputOutput: string, coreIdea: string, applicableSettings: string,
  knownLimitations: string | null, source: '领域常识' | '待核对' = '领域常识',
): BaselineCard => ({ id, name, aliases, kind, origin, task, inputOutput, coreIdea, codeURL: null, commonDatasets: [], applicableSettings, knownLimitations, source });

export const BASELINE_CARDS: BaselineCard[] = [
  C('fdk', 'FDK', ['Feldkamp-Davis-Kress', 'FBP', 'filtered back-projection'], '解析重建',
    'Feldkamp et al., 1984, JOSA A', '锥束几何的解析重建', '投影数据（sinogram）→ 体数据',
    '对投影先加权与滤波，再沿锥束几何反投影回三维体积；无需迭代优化。',
    '投影数量充足（通常数百视角以上）、噪声较低时作为性能下界；稀疏视角下是退化对照。',
    '稀疏视角/有限角下伪影显著；不对噪声与不完整数据建模。'),
  C('sart', 'SART', ['Simultaneous Algebraic Reconstruction Technique'], '迭代重建',
    'Andersen & Kak, 1984, Ultrasonic Imaging', '代数迭代重建', '投影数据 → 体数据（迭代更新）',
    '把重建当作线性方程组，每个视角做一次代数更新并交替扫描，逐步逼近与投影一致的解。',
    '稀疏视角下常用的迭代对照；可作为「无学习先验」的强基线。',
    '收敛速度与结果依赖迭代次数、松弛因子等超参；这些参数常不公开，跨论文比较需核对设置。'),
  C('asd-pocs', 'ASD-POCS', ['ASD POCS', 'adaptive steepest descent projection onto convex sets'], '迭代重建',
    'Sidky & Pan, 2008, Physics in Medicine & Biology', '带 TV 正则的迭代重建', '投影数据 → 体数据',
    '在 POCS 的数据一致性约束之外，加入全变差（TV）最小化的自适应最速下降步，抑制稀疏视角伪影。',
    '稀疏视角下的 TV 正则基线。', 'TV 正则会带来块状/阶梯伪影；正则权重需调参且常未报告。'),
  C('dudonet', 'DuDoNet', ['Dual Domain Network'], '混合 / 插件式', null,
    '双域（投影域 + 图像域）联合去伪影', '投影数据 → 投影域处理 → 图像域处理 → 体/图像数据',
    '在投影域与图像域各设一个网络，用可微的 Radon 反投影层连接两域，端到端联合优化。',
    '需要投影域信息参与的金属伪影/稀疏视角任务。',
    '两域级联的训练稳定性与损失权重敏感；原始论文的具体设置需回原文核对。'),
  C('c2rv', 'C²RV', ['C2RV', 'Cone-beam-to-Volume', 'cone beam to volume'], '深度学习', null,
    '稀疏视角 CBCT 重建（投影到体积的域变换视角）', '稀疏投影 → 体积',
    '从「域变换」角度建模投影到体积的映射，而非逐视角补全。',
    '稀疏视角 CBCT；作为有监督深度学习对照。',
    '需要训练数据；具体网络结构与训练协议需回原文核对（本卡片未记录，标记为待核对）。', '待核对'),
  C('nerp', 'NeRP', ['Neural Representation Prior', 'NeRP'], '隐式表示',
    'Shen et al., 2022, IEEE Trans. Med. Imaging', '稀疏视角 CT 重建（隐式神经表示）',
    '稀疏投影 → 连续神经场 → 体数据',
    '用 MLP 表示衰减场，先在已有先验数据上预训练，再用少量投影做单例优化。',
    '稀疏视角 CT；与 NAF 同属隐式表示路线，差别在是否依赖外部先验预训练。',
    '依赖预训练先验，属「需要外部训练数据」；跨域迁移效果需核对。'),
  C('trans2-cbct', 'Trans²-CBCT', ['Trans2-CBCT', 'Trans^2-CBCT', 'Trans2CBCT'], '深度学习', null,
    '稀疏视角 CBCT 重建（Transformer 路线）', '稀疏投影 → 体数据',
    '以 Transformer 建模投影间/体积内的长程依赖。',
    '稀疏视角 CBCT；作为 Transformer 架构对照。',
    '具体实现与训练设置需回原文核对（本卡片未记录）。', '待核对'),
  C('intratomo3d', 'IntraTomo3D', ['IntraTomo', 'IntraTomo 3D'], '隐式表示',
    'Zang et al., 2021, ICCV（IntraTomo 的 CBCT 变体）',
    '自监督稀疏视角/有限角重建（正弦图预测 + 几何修正）', '稀疏或有限角投影 → 密度场 → 重建体积',
    '把密度场表示为可微神经网络函数，用「正弦图预测模块」+「几何修正模块」交替迭代，自监督无需训练数据。',
    '极稀疏（可到 8 views）与有限角（45°）；NAF 论文中报其为重建耗时更长的对照（>1h vs 10–40min）。',
    '每例优化耗时较长；两模块交替的收敛性依赖迭代配置。'),
];

export function baselineCard(id: string): BaselineCard | null {
  return BASELINE_CARDS.find((c) => c.id === id) ?? null;
}

/** 按论文里出现的基线名匹配卡片，返回命中的卡片与原始写法。 */
export function matchBaselines(baselineNames: string[]): Array<{ card: BaselineCard; raw: string }> {
  const out: Array<{ card: BaselineCard; raw: string }> = [];
  const seen = new Set<string>();
  for (const raw of baselineNames) {
    if (!raw) continue;
    const key = baselineMatchKey(raw);
    if (!key) continue;
    for (const card of BASELINE_CARDS) {
      const hit = [card.name, ...card.aliases];
      if (hit.some((h) => baselineMatchKey(h) === key || key.includes(baselineMatchKey(h)))) {
        if (!seen.has(card.id)) { seen.add(card.id); out.push({ card, raw }); }
        break;
      }
    }
  }
  return out;
}

/** 「与当前论文的关系」：只区分「该论文确实提到了」与「未提及」，不做优劣推断。 */
export function baselineRelation(card: BaselineCard, baselineNames: string[]): string {
  const key = baselineMatchKey(card.name);
  const mentioned = baselineNames.some((raw) => {
    const k = baselineMatchKey(raw);
    return k === key || k.includes(key) || key.includes(k);
  });
  return mentioned
    ? `该论文的对比基线中包含 ${card.name}。`
    : `在当前抽取到的基线字段中未见 ${card.name}；如需对比请回原文核对。`;
}
