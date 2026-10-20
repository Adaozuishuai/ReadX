export type ReadingKind = 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';

export interface ReadingStep {
  kind: ReadingKind;
  label: string;
  questions: string[];
  outline: string[];
}

/** 精读五重奏的固定步骤。界面与 PPT 导出共用同一份定义。 */
export const READING_STEPS: ReadingStep[] = [
  { kind: 'motivation', label: '实验动机', questions: ['作者究竟要解决什么具体问题？', '既有方法的局限是否有原文依据？', '什么实验能够证伪研究假设？'], outline: ['问题与应用场景', '既有方法局限', '研究假设', '贡献与适用边界'] },
  { kind: 'method', label: '方法公式', questions: ['每个模块的输入、输出是什么？', '几何约束与损失如何进入优化？', '公式依赖什么假设，符号是否齐全？'], outline: ['输入与输出', '体积表示与模块流程', '投影约束与优化', '关键公式、符号与条件'] },
  { kind: 'experiment', label: '实验配置', questions: ['模拟与真实数据分别采用什么协议？', '对比方法是否使用一致的数据与预算？', '哪些参数原文未报告？'], outline: ['数据集与划分', '采集几何与预处理', '训练与损失', '基线与评价指标'] },
  { kind: 'results', label: '结果分析', questions: ['指标对应哪一组数据与采集协议？', '消融实验能否单独支持模块贡献？', '是否报告误差、重复实验或统计检验？'], outline: ['结果表与实验协议', '稳定性与消融', '泛化与效率', '统计报告与证据边界'] },
  { kind: 'reproduction', label: '代码复现', questions: ['代码、数据、权重是否实际公开？', '环境、特殊算子与计算成本是否明确？', '还需要向作者或仓库核对什么？'], outline: ['代码、数据与权重', '环境与依赖', '时间与显存成本', '缺失项与复现核对清单'] },
];

export function readingStep(kind: ReadingKind): ReadingStep {
  return READING_STEPS.find((step) => step.kind === kind) ?? READING_STEPS[0]!;
}
