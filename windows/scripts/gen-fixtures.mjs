/**
 * 生成 parity fixture 语料（提交进 git，供 Go 单测与 oracle 双跑共用）。
 *
 * 语料覆盖每条校验分支：合法、缺摘录、错页、数字不被支持、未知声明放行、引用号剔除、
 * 跨页拼接、配置混入结果、证据页码、结果表合法/列错位/绑定悬空、复现五组/错页引用/空组、
 * idea 的 origin 分流，以及已冻结在 testdata 中的历史样本。
 *
 * 用法：node windows/scripts/gen-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const v2 = path.resolve(here, '..');
const outDir = path.join(v2, 'apps', 'server', 'internal', 'validate', 'testdata');

// 合成全文：第 2 页直接给出「方法: PSNR x, SSIM y」两行，
// 让结果表的行摘录可以逐字命中，且单元格数值按列顺序出现在摘录里。
const SOURCE = [
  '=== Page 1 ===',
  'We train using 50 views and report PSNR of 33.05 dB on the Walnut dataset.',
  'The loss weight lambda is set to 0.5 and training takes 12 hours on one GPU.',
  '=== Page 2 ===',
  'Table 1 compares methods.',
  'NAF: PSNR 33.05 dB, SSIM 0.912',
  'FDK: PSNR 29.10 dB, SSIM 0.845',
  'References',
  '[1] Someone et al.',
].join('\n');

const PAGE1_QUOTE = 'We train using 50 views and report PSNR of 33.05 dB on the Walnut dataset.';
const NAF_QUOTE = 'NAF: PSNR 33.05 dB, SSIM 0.912';
const FDK_QUOTE = 'FDK: PSNR 29.10 dB, SSIM 0.845';

const field = (k, v, page, excerpt) => ({ k, v, page, excerpt });
const emptyExtraction = (over = {}) => ({
  dataset: [], acquisition: [], training: [], loss: [], metrics: [], results: [], baselines: [],
  ...over,
});

const goodTable = (transposeValues) => {
  // 列错位 = 把数值**交叉**挂到错误的列 ID 上（位置校验按列 ID 取值，
  // 只调换 cells 数组顺序不构成错位，因为查找是按 columnID 的）。
  const rowCells = (psnr, ssim) =>
    transposeValues
      ? [
          { columnID: 'psnr', valueText: ssim },
          { columnID: 'ssim', valueText: psnr },
        ]
      : [
          { columnID: 'psnr', valueText: psnr },
          { columnID: 'ssim', valueText: ssim },
        ];
  return {
    id: 't1',
    caption: field('表题', 'Table 1', 2, 'Table 1 compares methods.'),
    header: field('表头', 'method PSNR SSIM', 2, 'Table 1 compares methods.'),
    protocol: field('协议', 'Walnut 50 views', 1, PAGE1_QUOTE),
    columns: [
      {
        id: 'psnr', label: 'PSNR', metric: 'PSNR', unit: 'dB',
        context: field('列上下文', 'PSNR of 33.05 dB', 1, PAGE1_QUOTE),
        unitEvidence: field('单位', 'dB', 1, PAGE1_QUOTE),
      },
      {
        id: 'ssim', label: 'SSIM', metric: 'SSIM', unit: '论文未说明',
        context: field('列上下文', 'SSIM 列', 2, NAF_QUOTE),
      },
    ],
    rows: [
      { id: 'naf', method: 'NAF', evidence: field('方法行', 'NAF', 2, NAF_QUOTE), cells: rowCells('33.05', '0.912') },
      { id: 'fdk', method: 'FDK', evidence: field('方法行', 'FDK', 2, FDK_QUOTE), cells: rowCells('29.10', '0.845') },
    ],
  };
};

const discussion = (tableID) => ({
  evidence: field('解读依据', 'NAF 优于 FDK', 2, NAF_QUOTE),
  interpretation: 'NAF 的 PSNR 与 SSIM 都更高。',
  tableID,
  visualID: null,
});

const resultsPayload = (table, discussions) => ({
  tables: table ? [table] : [],
  stability: discussions, ablation: [], generalization: [], efficiency: [],
  statistics: [], missing: [],
});

// 未知项必须 page/excerpt 全 null 才走「未知声明」放行分支。
const knownItem = (k, excerpt, assessment, action) => ({
  finding: field(k, '见原文', 1, excerpt),
  assessment,
  action,
});
const unknownItem = (k, assessment, action) => ({
  finding: field(k, '论文未说明', null, null),
  assessment,
  action,
});
const reproGroups = (over = {}) => ({
  resources: [knownItem('数据可得性', 'We train using 50 views', '见 Page 1', '核对 Walnut 授权')],
  environment: [knownItem('特殊算子', 'training takes 12 hours on one GPU', '见 Page 1', '确认算子实现')],
  cost: [knownItem('训练时长', 'training takes 12 hours on one GPU', '见 Page 1', '记录墙钟时间')],
  missing: [unknownItem('几何参数未知', '论文未说明几何参数', '邮件询问作者')],
  risks: [knownItem('评测协议风险', 'report PSNR of 33.05 dB', '见 Page 1', '对齐 PSNR 计算方式')],
  ...over,
});

const fixtures = [
  {
    name: 'extraction-valid', kind: 'extraction', expect: { ok: true }, source: SOURCE,
    payload: emptyExtraction({
      dataset: [field('数据集', 'Walnut', 1, PAGE1_QUOTE)],
      training: [field('训练时长', '12 hours', 1, 'training takes 12 hours on one GPU')],
    }),
  },
  {
    name: 'extraction-missing-excerpt', kind: 'extraction', expect: { ok: false }, source: SOURCE,
    payload: emptyExtraction({ dataset: [field('数据集', 'Walnut', 1, null)] }),
  },
  {
    name: 'extraction-wrong-page', kind: 'extraction', expect: { ok: false }, source: SOURCE,
    payload: emptyExtraction({ dataset: [field('数据集', 'Walnut', 1, NAF_QUOTE)] }),
  },
  {
    name: 'extraction-unsupported-number', kind: 'extraction', expect: { ok: false }, source: SOURCE,
    payload: emptyExtraction({ metrics: [field('PSNR', '99.99 dB', 1, PAGE1_QUOTE)] }),
  },
  {
    name: 'extraction-declared-unknown', kind: 'extraction', expect: { ok: true }, source: SOURCE,
    payload: emptyExtraction({ metrics: [field('显著性检验', '论文未报告显著性检验', null, null)] }),
  },
  {
    name: 'extraction-citation-marker', kind: 'extraction', expect: { ok: true }, source: SOURCE,
    payload: emptyExtraction({ metrics: [field('PSNR', '33.05 dB [12]', 1, PAGE1_QUOTE)] }),
  },
  {
    name: 'extraction-cross-page', kind: 'extraction', expect: { ok: false }, source: SOURCE,
    payload: emptyExtraction({
      dataset: [field('数据集', 'Walnut + Table 1', 1, `${PAGE1_QUOTE}\n=== Page 2 ===\nTable 1 compares methods.`)],
    }),
  },
  {
    name: 'configuration-results-nonempty', kind: 'extraction', expect: { ok: false }, source: SOURCE,
    payload: emptyExtraction({
      dataset: [field('数据集', 'Walnut', 1, PAGE1_QUOTE)],
      results: [field('PSNR', '33.05', 1, PAGE1_QUOTE)],
    }),
  },
  { name: 'evidence-valid', kind: 'evidence', expect: { ok: true }, source: SOURCE, payload: '结论见 Page 1 与 Page 2。' },
  { name: 'evidence-bad-page', kind: 'evidence', expect: { ok: false }, source: SOURCE, payload: '结论见 Page 9。' },
  {
    name: 'results-valid', kind: 'results', expect: { ok: true }, source: SOURCE,
    payload: resultsPayload(goodTable(false), [discussion('t1')]), visuals: [],
  },
  {
    name: 'results-transposed', kind: 'results', expect: { ok: false }, source: SOURCE,
    payload: resultsPayload(goodTable(true), [discussion('t1')]), visuals: [],
  },
  {
    name: 'results-unbound-discussion', kind: 'results', expect: { ok: false }, source: SOURCE,
    payload: resultsPayload(goodTable(false), [discussion('nope')]), visuals: [],
  },
  { name: 'results-empty', kind: 'results', expect: { ok: false }, source: SOURCE, payload: resultsPayload(null, []), visuals: [] },
  { name: 'reproduction-valid', kind: 'reproduction', expect: { ok: true }, source: SOURCE, payload: reproGroups() },
  {
    name: 'reproduction-bad-page-ref', kind: 'reproduction', expect: { ok: false }, source: SOURCE,
    payload: reproGroups({ resources: [knownItem('数据可得性', 'We train using 50 views', '见 Page 9', '核对授权')] }),
  },
  { name: 'reproduction-empty-group', kind: 'reproduction', expect: { ok: false }, source: SOURCE, payload: reproGroups({ risks: [] }) },
  {
    name: 'idea-ai-origin-passes', kind: 'idea', expect: { ok: true }, source: SOURCE,
    payload: { id: 'i1', paperKey: 'k', paperTitle: 'T', origin: 'AI 解释', page: null, excerpt: '' },
  },
  {
    name: 'idea-paper-origin-bad-excerpt', kind: 'idea', expect: { ok: false }, source: SOURCE,
    payload: { id: 'i2', paperKey: 'k', paperTitle: 'T', origin: '论文原文', page: 1, excerpt: '完全不在原文里的话' },
  },
];

// ---- 修剪层（四层兜底的本地层）fixture ----
const pruneTable = (rows) => ({
  id: 't1',
  caption: field('表题', 'Table 1', 2, 'Table 1 compares methods.'),
  header: field('表头', 'method PSNR', 2, 'Table 1 compares methods.'),
  protocol: field('协议', 'Walnut 50 views', 1, PAGE1_QUOTE),
  columns: [
    {
      id: 'psnr', label: 'PSNR', metric: 'PSNR', unit: 'dB',
      context: field('列上下文', 'PSNR of 33.05 dB', 1, PAGE1_QUOTE),
      unitEvidence: field('单位', 'dB', 1, PAGE1_QUOTE),
    },
  ],
  rows,
});
const pruneRow = (id, method, excerpt, value) => ({
  id, method,
  evidence: field('方法行', method, 2, excerpt),
  cells: [{ columnID: 'psnr', valueText: value }],
});
const goodRows = [
  pruneRow('naf', 'NAF', NAF_QUOTE, '33.05'),
  pruneRow('fdk', 'FDK', FDK_QUOTE, '29.10'),
];

fixtures.push(
  {
    name: 'prune-experiment-bad-field', kind: 'prune-experiment', source: SOURCE,
    payload: emptyExtraction({
      dataset: [
        field('数据集', 'Walnut', 1, PAGE1_QUOTE),
        field('视图数', '999 views', 1, '完全对不上的摘录'),
      ],
    }),
  },
  {
    name: 'prune-experiment-with-results', kind: 'prune-experiment', source: SOURCE,
    payload: emptyExtraction({
      dataset: [field('数据集', 'Walnut', 1, PAGE1_QUOTE)],
      results: [field('PSNR', '33.05', 1, PAGE1_QUOTE)],
    }),
  },
  {
    name: 'prune-results-bad-row', kind: 'prune-results', source: SOURCE,
    payload: resultsPayload(
      pruneTable([
        goodRows[0],
        pruneRow('bad', 'BAD', '这一行摘录不在第 2 页', '11.11'),
        goodRows[1],
      ]),
      [],
    ),
    visuals: [],
  },
  {
    name: 'prune-results-all-bad', kind: 'prune-results', source: SOURCE,
    payload: resultsPayload(
      pruneTable([
        pruneRow('bad1', 'BAD1', '摘录一不在原文', '11.11'),
        pruneRow('bad2', 'BAD2', '摘录二不在原文', '22.22'),
      ]),
      [],
    ),
    visuals: [],
  },
  {
    // 解读同时缺 tableID/visualID：绑定错误无法靠修剪收敛，应返回 null 走未核验通道。
    // 绑定校验不在生成物校验里（与旧版一致：validateGeneratedOutput 只跑 decode+validateResults），
    // 所以带悬空解读的 payload 会原样通过修剪——绑定留到 S3 图分析落地后再强制。
    name: 'prune-results-bindings-deferred', kind: 'prune-results', source: SOURCE,
    payload: resultsPayload(pruneTable(goodRows), [{ evidence: field('解读依据', 'x', 2, NAF_QUOTE), interpretation: 'i', tableID: null, visualID: null }]),
    visuals: [],
  },
);

// Historical samples are frozen test fixtures; never read the user's library.
for (const name of ['real-experiment', 'real-results-legacy-unbound']) {
  const file = path.join(outDir, name + '.json');
  if (fs.existsSync(file)) fixtures.push(JSON.parse(fs.readFileSync(file, 'utf8')));
}

fs.mkdirSync(outDir, { recursive: true });
for (const fixture of fixtures) {
  fs.writeFileSync(path.join(outDir, `${fixture.name}.json`), JSON.stringify(fixture, null, 2) + '\n');
}
console.log(`已生成 ${fixtures.length} 份 fixture → ${outDir}`);
