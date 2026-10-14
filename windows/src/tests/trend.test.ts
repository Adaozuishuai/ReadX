// 趋势分析移植保真回归：把早期 macOS（Swift）版回归用例 TrendTests.swift 的断言
// 逐条翻成 TS，并补上 PRD 4.16 / 第 12 节风险表的硬约束用例。
// 任何一条失败都说明移植改变了语义，而不是「测试太严」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  minimumSample, window, sample, findings, gapStatement, disclosure,
  violatesRedline, forbiddenPhrases, negationMarkers, isWindowBounded,
} from '../core/trend';
import { derive } from '../core/systemTags';
import { QueueEntry } from '../core/types';
import { findRoot, Paths, readJSON } from '../core/store';
import { decodeQueue } from '../core/paper';

/** Swift 测试里的 trendPaper：published = year + "-01-01"，title 即匹配文本。 */
function trendPaper(id: string, year: string, text: string): QueueEntry {
  return { id, title: text, published: year + '-01-01' };
}

const fromTitle = (p: QueueEntry): ReturnType<typeof derive> => derive([p.title ?? '']);

// ---------------------------------------------------------------------------
// 时间窗口（PRD 4.16 硬约束 1）
// ---------------------------------------------------------------------------

test('window 从 published/year 提取年份并取 min/max，缺失时显式未知', () => {
  const papers = [
    trendPaper('a', '2021', 'sparse-view'),
    trendPaper('b', '2024', 'low-dose'),
    trendPaper('c', '2023', 'sparse-view'),
  ];
  const s = sample(papers);
  assert.equal(s.windowStart, '2021');
  assert.equal(s.windowEnd, '2024');
  assert.equal(s.papers.length, 3);
  assert.equal(isWindowBounded(s), true);
  assert.deepEqual(window(papers), ['2021', '2024']);

  // 年份缺失时必须显式标记为未知，而不是编造
  const noYear = sample([{ id: 'x', title: 'no year' }]);
  assert.equal(isWindowBounded(noYear), false);
  assert.equal(noYear.windowStart, null);
  assert.equal(noYear.windowEnd, null);
  assert.deepEqual(window([]), [null, null]);
});

test("window 对 '2026-09-30' / '2026-09' / '2026' / 缺失的处理", () => {
  // 前 4 个字符里恰好 4 位数字才采用
  assert.deepEqual(window([{ published: '2026-09-30' }]), ['2026', '2026']);
  assert.deepEqual(window([{ published: '2026-09' }]), ['2026', '2026']);
  assert.deepEqual(window([{ published: '2026' }]), ['2026', '2026']);
  // 缺失
  assert.deepEqual(window([{}]), [null, null]);
  assert.deepEqual(window([{ published: null, year: null }]), [null, null]);
  assert.deepEqual(window([{ published: '' }]), [null, null]);

  // published 不合格时回退到 year；year 合格仍可定窗口
  assert.deepEqual(window([{ published: 'in press', year: '2023' }]), ['2023', '2023']);
  assert.deepEqual(window([{ published: '20-2', year: '2019-05-01' }]), ['2019', '2019']);

  // published 合格则优先于 year，不再看 year
  assert.deepEqual(window([{ published: '2022-01-01', year: '1999' }]), ['2022', '2022']);

  // '26-09-30' 的前 4 字符是 '26-0'，只有 3 位数字 -> 不采用，且无 year 回退 -> 未知（不编造 26 年）
  assert.deepEqual(window([{ published: '26-09-30' }]), [null, null]);
  // 前 4 字符里数字不足 4 位同样丢弃
  assert.deepEqual(window([{ published: 'abc' }]), [null, null]);
  assert.deepEqual(window([{ published: '1 2 3 4 5' }]), [null, null]);

  // 多条混合：未知年份不参与 min/max，也不拉低窗口
  assert.deepEqual(
    window([{ published: '2026-09-30' }, {}, { year: '2018' }, { published: 'bad' }]),
    ['2018', '2026'],
  );
});

// ---------------------------------------------------------------------------
// 样本不足拒下判断（PRD 风险表：样本少导致伪趋势）
// ---------------------------------------------------------------------------

test('minimumSample 是 5，样本不足时 isSupported=false 且明说不下判断', () => {
  assert.equal(minimumSample, 5);

  const few = Array.from({ length: 4 }, (_, i) => trendPaper('p' + i, '2023', 'sparse-view CBCT'));
  const short = findings(few, fromTitle);
  assert.ok(short.length > 0);
  const sparseFew = short.find((f) => f.topic === 'Sparse-view');
  assert.ok(sparseFew, '4 篇也应输出计数条目');
  assert.equal(sparseFew.count, 4);
  assert.equal(sparseFew.isSupported, false);
  assert.ok(sparseFew.claim.includes('样本不足，不下趋势判断'), sparseFew.claim);
  assert.ok(sparseFew.caveat.includes('不下趋势判断'), sparseFew.caveat);
  assert.ok(sparseFew.caveat.includes('样本数 4 < 5'), sparseFew.caveat);
  for (const f of short) assert.equal(f.isSupported, false, '样本不足却标记为可支持：' + f.topic);
});

test('样本数达到 5 就给出计数型结论，但仍不得声称升温/首次', () => {
  const enough = Array.from({ length: 5 }, (_, i) => trendPaper('q' + i, '2023', 'sparse-view CBCT'));
  const supported = findings(enough, fromTitle);
  const sparse = supported.find((f) => f.topic === 'Sparse-view');
  assert.ok(sparse);
  assert.equal(sparse.count, 5);
  assert.equal(sparse.isSupported, true);
  assert.equal(sparse.claim, '5 篇论文涉及 Sparse-view');
  assert.ok(!sparse.claim.includes('样本不足'));
  assert.ok(!sparse.claim.includes('升温'));
  assert.ok(sparse.caveat.includes('不代表'), sparse.caveat);
  assert.ok(sparse.caveat.includes('升温'), sparse.caveat);
  assert.ok(sparse.caveat.includes('首次'), sparse.caveat);

  // 边界：恰好 5 篇支持，4 篇不支持
  const four = findings(enough.slice(0, 4), fromTitle);
  assert.equal(four.find((f) => f.topic === 'Sparse-view')?.isSupported, false);
});

test('claim 与 caveat 分离且文案一致：claim 只有计数，caveat 才带免责', () => {
  for (const n of [1, 4, 5, 7]) {
    const papers = Array.from({ length: n }, (_, i) => trendPaper('c' + i, '2022', 'sparse-view'));
    const f = findings(papers, fromTitle).find((x) => x.topic === 'Sparse-view');
    assert.ok(f);
    assert.ok(f.claim.startsWith(n + ' 篇论文涉及 Sparse-view'), f.claim);
    assert.ok(f.caveat.length > f.claim.length, 'caveat 必须是独立的免责说明');
    assert.notEqual(f.claim, f.caveat);
    // claim 里绝不能出现红线措辞
    assert.equal(violatesRedline(f.claim), false, f.claim);
    if (f.isSupported) assert.ok(f.caveat.includes('不代表'));
    else assert.ok(f.caveat.includes('请扩大检索范围后重试'));
  }
});

// ---------------------------------------------------------------------------
// 证据集合 + 排序（PRD 4.16 硬约束 3）
// ---------------------------------------------------------------------------

test('每条结论都携带证据集合，能指出是哪几篇论文', () => {
  const papers = Array.from({ length: 6 }, (_, i) => trendPaper('e' + i, '2023', 'sparse-view CBCT with PSNR'));
  const fs2 = findings(papers, fromTitle);
  const sparse = fs2.find((f) => f.topic === 'Sparse-view');
  assert.ok(sparse);
  assert.equal(sparse.count, 6);
  assert.equal(sparse.evidence.length, 1);
  assert.equal(sparse.evidence[0].papers.length, 6);
  const keys = sparse.evidence[0].papers.map((p) => p.id);
  assert.equal(new Set(keys).size, 6);
  // PSNR 也各自成立，证据集合不串台
  const psnr = fs2.find((f) => f.topic === 'PSNR');
  assert.ok(psnr);
  assert.equal(psnr.count, 6);
  assert.equal(psnr.evidence[0].tag.category, 'Metric');
  // 同一论文同时进入两个标签的证据集合是允许的（多标签论文）
  assert.equal(sparse.evidence[0].papers[0], psnr.evidence[0].papers[0]);
});

test('findings 按 category|value 聚合，同一 value 不因论文重复而重复分组', () => {
  const papers = Array.from({ length: 5 }, (_, i) => trendPaper('d' + i, '2022', 'sparse-view sparse view few-view'));
  const fs2 = findings(papers, fromTitle);
  assert.equal(fs2.length, 1, '同一 value 只应产生一条结论');
  assert.equal(fs2[0].topic, 'Sparse-view');
  assert.equal(fs2[0].count, 5);
});

test('排序：count 降序，同 count 按 topic 升序', () => {
  const papers: QueueEntry[] = [
    // Sparse-view x3
    trendPaper('a1', '2021', 'sparse-view'), trendPaper('a2', '2021', 'sparse-view'), trendPaper('a3', '2021', 'sparse-view'),
    // PSNR x3
    trendPaper('b1', '2021', 'psnr'), trendPaper('b2', '2021', 'psnr'), trendPaper('b3', '2021', 'psnr'),
    // Low-dose x5
    ...Array.from({ length: 5 }, (_, i) => trendPaper('l' + i, '2021', 'low-dose')),
  ];
  const fs2 = findings(papers, fromTitle);
  assert.deepEqual(fs2.map((f) => [f.count, f.topic]), [
    [5, 'Low-dose'],
    [3, 'PSNR'],
    [3, 'Sparse-view'],
  ]);
  // 同 count 时按 topic 升序（'PSNR' < 'Sparse-view'）
  assert.ok(fs2[1].topic < fs2[2].topic);
});

// ---------------------------------------------------------------------------
// disclosure：时间窗 + 样本数 + 证据，三样缺一不可
// ---------------------------------------------------------------------------

test('disclosure 同时含时间窗口、样本数、证据三部分', () => {
  const papers = Array.from({ length: 6 }, (_, i) => trendPaper('d' + i, '2022', 'sparse-view'));
  const f = findings(papers, fromTitle)[0];
  const d = disclosure(f);
  assert.ok(d.includes('时间窗口'), d);
  assert.ok(d.includes('样本数'), d);
  assert.ok(d.includes('证据'), d);
  assert.ok(d.includes('6 篇'), d);
  assert.ok(d.includes('2022 ~ 2022'), d);
  assert.ok(d.includes('Sparse-view(6)'), d);
  // 三段用 · 分隔，与 Swift 文案一致
  assert.ok(/时间窗口：2022 ~ 2022 · 样本数：6 篇 · 证据：Sparse-view\(6\)/.test(d), d);

  // 窗口未知时也必须显式说明，而不是省略这一段
  const unknown = findings([{ id: 'u', title: 'sparse-view' }], fromTitle)[0];
  const du = disclosure(unknown);
  assert.ok(du.includes('时间窗口未知'), du);
  assert.ok(du.includes('样本数：1 篇'), du);
  assert.ok(du.includes('证据：'), du);
});

// ---------------------------------------------------------------------------
// gapStatement + 红线自检
// ---------------------------------------------------------------------------

test('gapStatement 只表述「检索范围内未见」，并明确不等于无人研究、不构成首次', () => {
  const papers = Array.from({ length: 2 }, (_, i) => trendPaper('g' + i, '2023', 'some topic'));
  const stmt = gapStatement('金属伪影', sample(papers));
  assert.ok(stmt.includes('未发现'), stmt);
  assert.ok(stmt.includes('检索范围内'), stmt);
  assert.ok(stmt.includes('不等于该方向无人研究'), stmt);
  assert.ok(stmt.includes('不构成「首次」声明'), stmt);
  assert.ok(stmt.includes('2 篇'), stmt);
  assert.ok(stmt.includes('2023–2023'), stmt);
  assert.equal(violatesRedline(stmt), false, 'gapStatement 自身必须通过红线自检：' + stmt);

  // 窗口未知时用「当前」而不是编造区间
  const unknown = gapStatement('x', sample([{ id: 'x', title: 'n' }]));
  assert.ok(unknown.includes('在 当前 的 1 篇检索范围内'), unknown);
  assert.ok(unknown.includes('0 篇') === false);
  assert.equal(violatesRedline(unknown), false);
});

test('红线自检：违规措辞命中即 true，否定语境放行', () => {
  // 违规
  assert.equal(violatesRedline('这是首次提出该方法'), true);
  assert.equal(violatesRedline('首个 4D-CBCT 工作'), true);
  assert.equal(violatesRedline('No one has tried this'), true);
  assert.equal(violatesRedline('our method is First To solve this'), true);
  assert.equal(violatesRedline('此前无人研究过这个问题'), true);
  assert.equal(violatesRedline('这是前所未有的尝试'), true);
  // 合规
  assert.equal(violatesRedline('不构成「首次」声明'), false);
  assert.equal(violatesRedline('并非首个'), false);
  assert.equal(violatesRedline('这不是首次提出'), false);
  assert.equal(violatesRedline('不能声称首个'), false);
  assert.equal(violatesRedline('在检索范围内未发现直接工作'), false);
  assert.equal(violatesRedline('6 篇论文涉及 Sparse-view'), false);
  assert.equal(violatesRedline(''), false);
  // 注意：这条**不是** false。Swift 实测为 true——否定标记 'no claim of' 距离 'first to'
  // 超过 12 字符窗口，因而未被识别为否定语境。这是原实现的已知弱点，移植时保真保留，
  // 不做「顺手修好」，否则两平台判定会不一致。用真实 Swift 跑过同一条断言（见 README）。
  assert.equal(violatesRedline('no claim of being first to do this'), true);

  // 12 字符窗口的**真实**语义（以下三条都用真实 Swift 逐条跑过）：
  // - '不是' 落在 '首次' 前 12 字符内，因此整句被当作否定语境而放行（false）。
  //   语义上并不理想——'不是' 否定的是别的事——但这就是原实现的行为，移植保真。
  assert.equal(violatesRedline('不是这回事，但这是首次提出'), false);
  // - 第二处 '首个' 前的窗口里没有否定标记，因此整句判违规（true）。
  //   （原用例 '也不代表这是首个工作' 在 '不代表' 加入否定表后语义上本就是否定用法，
  //     已换成真正无否定语境的句子；supported caveat 的 '不代表…首次' 必须放行，见端到端测试。）
  assert.equal(violatesRedline('不构成「首次」声明，而且这是首个实现'), true);
  // - 窗口外的否定标记不生效，证明 12 字符窗口确实在起作用。
  assert.equal(violatesRedline('不构成声明：该方向此前长期无人研究过'), true);
});

test('红线表本身完整：forbiddenPhrases 与 negationMarkers 全表搬过来', () => {
  assert.deepEqual(forbiddenPhrases, ['首次', '首个', 'first to', 'no one has', '无人研究过', '前所未有的']);
  assert.deepEqual(negationMarkers, [
    '不构成', '不代表', '不是', '不等于', '并非', '不得', '不能', '禁止',
    '无「', '不存在', 'no claim of', 'not the first',
  ]);
  // 每个禁用语单独出现都必须被判违规
  for (const phrase of forbiddenPhrases) {
    assert.equal(violatesRedline('这是 ' + phrase + ' 的说法'), true, '未拦截：' + phrase);
  }
  // 每个否定标记都能放行紧随其后的禁用语。
  // 例外：'not the first' 与 '「首次」' 之间隔了引号，前缀里不含完整字面量，Swift 实测为 true。
  // 这是原实现把否定标记写成「整串字面量」而非「前缀」的固有局限，保真保留。
  for (const marker of negationMarkers) {
    const expected = marker === 'not the first' ? true : false;
    assert.equal(violatesRedline(marker + '「首次」'), expected, '判定不符：' + marker);
  }
  // 用中英混排最常见的合规写法再确认一次（这些必须放行）
  for (const ok of ['不构成「首次」声明', '并非首个', '不能声称首个', '不等于首次提出']) {
    assert.equal(violatesRedline(ok), false, '合规表述被误判：' + ok);
  }
});

// ---------------------------------------------------------------------------
// 空集合安全
// ---------------------------------------------------------------------------

test('空集合安全：不崩溃、不给结论、显式报 0 篇', () => {
  const empty: QueueEntry[] = [];
  assert.equal(sample(empty).papers.length, 0);
  assert.equal(isWindowBounded(sample(empty)), false);
  assert.deepEqual(findings(empty, () => []), []);
  const stmt = gapStatement('x', sample(empty));
  assert.ok(stmt.includes('0 篇'), stmt);
  assert.ok(stmt.includes('在 当前 的'), stmt);
  assert.equal(violatesRedline(stmt), false);
});

// ---------------------------------------------------------------------------
// 真实数据端到端
// ---------------------------------------------------------------------------

test('真实 queue.json 端到端：计数、窗口、NAF 相关条目合理', () => {
  const ROOT = findRoot(__dirname);
  const paths = new Paths(ROOT);
  const raw = readJSON<unknown>(paths.queuePath, { papers: [] });
  const queue = decodeQueue(raw);
  assert.ok(queue.length >= 1, '真实队列不应为空：' + paths.queuePath);

  const fs2 = findings(queue, (p) => derive([
    p.title ?? '', p.abstract ?? '', p.venue ?? '', p.why ?? '',
  ]));

  // 每条结论都必须能通过红线自检，且完整披露三要素
  for (const f of fs2) {
    assert.equal(violatesRedline(f.claim), false, f.claim);
    assert.equal(violatesRedline(f.caveat), false, f.caveat);
    const d = disclosure(f);
    for (const part of ['时间窗口', '样本数', '证据']) assert.ok(d.includes(part), d);
    assert.ok(f.count >= 1);
    assert.equal(f.evidence[0].papers.length, f.count);
    assert.equal(new Set(f.evidence[0].papers.map((p) => p.id ?? p.arxiv)).size, f.count);
  }

  // 实得分组。队列是随用户导入增长的真实数据，计数断言必须自适应：
  // 钉死具体篇数会让测试在用户导入第 N 篇论文那天准时误报（曾经如此）。
  const byTopic = new Map(fs2.map((f) => [f.topic, f]));
  const sparse = byTopic.get('Sparse-view');
  assert.ok(sparse, '真实队列应命中 Sparse-view；实得：' + fs2.map((f) => f.topic).join(','));
  assert.ok(sparse.count >= 4, '至少 4 篇主线论文应命中 Sparse-view');
  assert.equal(sparse.count, queue.length, '当前队列全部条目都属于稀疏视角主线');
  assert.equal(sparse.isSupported, sparse.count >= minimumSample, 'supported 门槛必须由 minimumSample 决定');
  if (!sparse.isSupported) assert.ok(sparse.claim.includes('样本不足，不下趋势判断'));
  assert.equal(sparse.evidence[0].tag.category, 'Task');
  // category|value 聚合的唯一性
  assert.equal(fs2.length, new Set(fs2.map((f) => f.topic + '|' + f.evidence[0].tag.category)).size);

  // NAF 相关条目（intratomo-2021 与 2312.15676 / 2401.00135 均属稀疏视角主线）
  const nafKeys = sparse.evidence[0].papers.map((p) => p.id ?? p.arxiv);
  assert.ok(nafKeys.includes('intratomo-2021'), 'IntraTomo 应命中 Sparse-view：' + nafKeys.join(','));
  assert.ok(nafKeys.includes('2312.15676'), '3DGR-CT 应命中 Sparse-view');
  assert.ok(nafKeys.includes('2401.00135'), 'Deep Radon Prior 应命中 Sparse-view');
  assert.ok(nafKeys.includes('2608.23190'), 'Diffusion 基础先验论文应命中 Sparse-view');

  // 时间窗口取自真实字段：1 篇 published=2026-08-24，其余用 year=2021/2023
  const w = window(queue);
  assert.deepEqual(w, ['2021', '2026']);
  assert.equal(isWindowBounded(sample(queue)), true);
  const diff = byTopic.get('Diffusion');
  assert.ok(diff, '真实队列应命中 Diffusion');
  assert.ok(diff.count >= 1);
  assert.equal(diff.isSupported, diff.count >= minimumSample);
  assert.equal(diff.evidence[0].tag.category, 'Architecture');

  // 真实数据上 gapStatement 也必须通过自检
  assert.equal(violatesRedline(gapStatement('金属伪影', sample(queue))), false);
});
