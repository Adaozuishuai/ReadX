// 向量检索（R-05）与架构图解析（FigureAnalysis）的回归。
//
// 两个模块的共同硬约束：**不猜**。检索的嵌入响应必须按 index 重排并拒绝不完整向量；
// 图的模块标签必须能在图内 OCR 里找到，否则剔除——绝不把凭空编造的结构渲染出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cosine, fingerprint, embeddingBase, embeddingVectors, chunks, terms, keywordScore,
  matchesSource, matchesEmbedding, selectTopPassages, libraryContextBlock, RetrievalIndex,
} from '../core/retrieval';

import {
  decodeFigureAnalysis, validateFigureAnalysis, figureUsable, figureLayers, layoutFigure, figureSVG,
  FigureAnalysis,
} from '../core/figureAnalysis';

// ---------- 检索：纯函数 ----------

test('余弦相似度：相同/正交/零向量/维度不一致', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0, '零向量返回 0');
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, '维度不一致返回 0');
  assert.equal(cosine([1, NaN], [1, 1]), 0, '非有限值返回 0');
});

test('embeddingBase 去掉尾部斜杠；指纹稳定', () => {
  assert.equal(embeddingBase('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(embeddingBase('  https://a/b///  '), 'https://a/b');
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abd'));
});

test('嵌入响应按 index 重排（顺序不保证）', () => {
  const entries = [
    { index: 1, embedding: [3, 4] },
    { index: 0, embedding: [1, 2] },
  ];
  const v = embeddingVectors(entries, 2);
  assert.deepEqual(v, [[1, 2], [3, 4]]);
});

test('嵌入响应：数量不符 / 重复 index / 维度不一 一律拒绝', () => {
  assert.equal(embeddingVectors([{ index: 0, embedding: [1] }], 2), null, '缺一个');
  assert.equal(embeddingVectors([{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }], 2), null, '重复 index');
  assert.equal(embeddingVectors([{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }], 2), null, '维度不一');
  assert.equal(embeddingVectors([{ index: 5, embedding: [1] }], 1), null, '越界 index');
});

test('分块：短页整页一块，超长页按 ~1200 字切且页码保留', () => {
  const src = '=== Page 1 ===\nshort\n\n=== Page 2 ===\n' + 'x'.repeat(3000);
  const cs = chunks('p1', src);
  assert.equal(cs.filter((c) => c.page === 1).length, 1);
  assert.ok(cs.filter((c) => c.page === 2).length >= 3, '3000 字应切成 3 块以上');
  assert.ok(cs.every((c) => c.text.length <= 1600));
});

test('分词与关键词打分', () => {
  assert.deepEqual(terms('Sparse-view CBCT reconstruction'), ['sparse', 'view', 'cbct', 'reconstruction']);
  assert.equal(keywordScore('cbct and cbct again', ['cbct']), 2);
  assert.equal(keywordScore('nothing here', ['absent']), 0);
});

test('索引新鲜度：指纹不符返回 false，页码数不符返回 false', () => {
  const src = '=== Page 1 ===\nhello world content here';
  const idx: RetrievalIndex = {
    key: 'k', pageCount: 1, model: null, builtAt: 'x', chunks: chunks('k', src),
    sourceFingerprint: fingerprint(src), embeddingBase: null, embedFailures: {},
  };
  assert.equal(matchesSource(idx, 'k', src), true);
  assert.equal(matchesSource(idx, 'k', src + '\n=== Page 2 ===\nmore'), false, '页码数变了');
  assert.equal(matchesSource(idx, 'other', src), false, 'key 不符');
});

test('嵌入一致性：模型与端点都要匹配', () => {
  const idx: RetrievalIndex = {
    key: 'k', pageCount: 1, model: 'text-embedding-3-small', builtAt: 'x', chunks: [],
    sourceFingerprint: null, embeddingBase: 'https://api.example.com/v1', embedFailures: null,
  };
  assert.equal(matchesEmbedding(idx, 'text-embedding-3-small', 'https://api.example.com/v1/'), true, '尾部斜杠不影响');
  assert.equal(matchesEmbedding(idx, 'other-model', 'https://api.example.com/v1'), false);
  assert.equal(matchesEmbedding(idx, 'text-embedding-3-small', 'https://other'), false);
});

test('候选段落：关键词回退时每篇取最佳块，跨论文取 topK', () => {
  const mkIndex = (key: string, texts: string[]): RetrievalIndex => ({
    key, pageCount: 1, model: null, builtAt: 'x',
    chunks: texts.map((t, i) => ({ paper: key, page: i + 1, text: t })),
    sourceFingerprint: null, embeddingBase: null, embedFailures: null,
  });
  const indices = {
    a: mkIndex('a', ['unrelated words only', 'sparse-view cbct reconstruction works']),
    b: mkIndex('b', ['cbct cbct cbct everywhere', 'nothing']),
    c: mkIndex('c', ['totally different topic']),
  };
  const out = selectTopPassages(indices, { a: 'Paper A', b: 'Paper B', c: 'Paper C' }, null, 'cbct reconstruction', 'm', 'base', 2);
  assert.equal(out.length, 2);
  assert.ok(out.every((p) => p.paper === 'a' || p.paper === 'b'), '只返回有命中的论文');
  assert.ok(out.every((p) => !p.viaEmbedding), '无查询向量时走关键词');
});

test('候选段落：查询无有效词返回空', () => {
  const idx: RetrievalIndex = { key: 'a', pageCount: 1, model: null, builtAt: 'x', chunks: [{ paper: 'a', page: 1, text: 'cbct' }], sourceFingerprint: null, embeddingBase: null, embedFailures: null };
  assert.deepEqual(selectTopPassages({ a: idx }, {}, null, 'a b', 'm', 'b', 3), [], '长度 ≤2 的词不算');
});

test('候选段落：语义命中不被无向量的尾部块压掉（不混比两种打分量纲）', () => {
  // 一篇论文 100 个块，只有第 0 块有向量且语义最相关；后 99 块无向量。
  // 若在同一循环里混比 cosine(0–1) 与关键词密度(0–1000)，尾部的关键词块会压掉语义命中。
  const base: RetrievalIndex = {
    key: 'a', pageCount: 1, model: 'emb', builtAt: 'x',
    chunks: [
      { paper: 'a', page: 1, text: 'the semantically best chunk', vector: [1, 0] },
      ...Array.from({ length: 99 }, (_, i) => ({ paper: 'a', page: 2, text: 'cone beam cbct ' + i })),
    ],
    sourceFingerprint: null, embeddingBase: 'base', embedFailures: null,
  };
  const out = selectTopPassages({ a: base }, { a: 'A' }, [1, 0], 'cbct', 'emb', 'base', 3);
  assert.equal(out.length, 1);
  assert.equal(out[0].viaEmbedding, true, '有向量的论文应走语义打分');
  assert.equal(out[0].page, 1, '语义最相关的块应胜出');
});

test('候选段落：语义命中优先于关键词命中（跨论文不混尺度）', () => {
  const semantic: RetrievalIndex = {
    key: 's', pageCount: 1, model: 'emb', builtAt: 'x', embeddingBase: 'base', sourceFingerprint: null, embedFailures: null,
    chunks: [{ paper: 's', page: 5, text: 'semantic match', vector: [1, 0] }],
  };
  const lexical: RetrievalIndex = {
    key: 'l', pageCount: 1, model: null, builtAt: 'x', embeddingBase: null, sourceFingerprint: null, embedFailures: null,
    chunks: [{ paper: 'l', page: 2, text: 'cbct cbct cbct cbct cbct' }],
  };
  const out = selectTopPassages({ s: semantic, l: lexical }, { s: 'S', l: 'L' }, [1, 0], 'cbct', 'emb', 'base', 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].paper, 's', '语义命中优先于关键词命中');
  assert.equal(out[0].viaEmbedding, true);
});

test('候选材料块带来源标注与「必须写论文名+页码」硬约束', () => {
  const block = libraryContextBlock([{ paper: 'a', title: 'Paper A', page: 3, text: 'some evidence text', viaEmbedding: false }]);
  assert.ok(block.includes('Paper A · Page 3'));
  assert.ok(block.includes('必须同时写出论文名与 Page N'));
  assert.equal(libraryContextBlock([]), '');
});

// ---------- 架构图：校验 / 布局 ----------

const mkAnalysis = (over: Partial<FigureAnalysis> = {}): FigureAnalysis => ({
  page: 3, title: 'Figure 2', nodes: [], edges: [], dropped: [], note: '', panels: [], ...over,
});

test('图解析校验：标签必须在图内 OCR 里出现，否则剔除', () => {
  const a = mkAnalysis({
    nodes: [
      { id: 'n1', label: 'Hash Encoder', kind: 'module' },
      { id: 'n2', label: 'MLP', kind: 'module' },
      { id: 'n3', label: 'Fabricated Block', kind: 'module' },
    ],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
  });
  const v = validateFigureAnalysis(a, 'Hash Encoder -> MLP with hash encoding');
  assert.equal(v.nodes.length, 2, '编造的标签被剔除');
  assert.ok(v.dropped.some((d) => d.includes('Fabricated')));
  // n3 被剔除后，指向它的边也消失
  assert.equal(v.edges.length, 1);
  assert.ok(v.note.includes('已剔除'));
});

test('图解析校验：空/重复 id 被剔除；自环边被去掉', () => {
  const a = mkAnalysis({
    nodes: [{ id: 'x', label: 'MLP', kind: 'module' }, { id: 'x', label: 'MLP', kind: 'module' }, { id: '', label: 'Ghost', kind: 'module' }],
    edges: [{ from: 'x', to: 'x' }],
  });
  const v = validateFigureAnalysis(a, 'MLP');
  assert.equal(v.nodes.length, 1, '重复 id 只保留一个');
  assert.equal(v.edges.length, 0, '自环被去掉');
});

test('图解析校验：边标签必须被图内 OCR 核验，未核验的连同边剔除并披露', () => {
  const nodes = [
    { id: 'n1', label: 'Hash Encoder', kind: 'module' },
    { id: 'n2', label: 'MLP', kind: 'module' },
  ];
  // 编造的边标签：OCR 文本里没有 "gradient flow"
  const fabricated = mkAnalysis({ nodes, edges: [{ from: 'n1', to: 'n2', label: 'gradient flow' }] });
  const v = validateFigureAnalysis(fabricated, 'Hash Encoder MLP');
  assert.equal(v.edges.length, 0, '未核验的边标签必须连同边剔除');
  assert.ok(v.dropped.some((d) => d.includes('gradient flow')), '剔除必须披露');
  // 标签确实出现在图内文字里：保留
  const v2 = validateFigureAnalysis(fabricated, 'Hash Encoder gradient flow MLP');
  assert.equal(v2.edges.length, 1);
  // 无标签边保留，但 note 必须披露「连接关系是模型判读」
  const bare = mkAnalysis({ nodes, edges: [{ from: 'n1', to: 'n2' }] });
  const v3 = validateFigureAnalysis(bare, 'Hash Encoder MLP');
  assert.equal(v3.edges.length, 1);
  assert.ok(v3.note.includes('视觉模型判读'), '连接方向不可核验，必须向用户披露');
});

test('图解析校验：子图裁剪框必须在 [0,1] 且不小于 0.08；子图标记须被局部 OCR 核验', () => {
  // 子图 OCR 里必须能核验到图内标记（id 独占一行）或子图标签本身
  const base = { id: 'a', label: 'Encoder', nodes: [], edges: [], ocrText: '(a)\nEncoder\nConv', dropped: [], note: '' };
  const bad = mkAnalysis({ panels: [{ ...base, x: -0.1, y: 0, width: 0.5, height: 0.5 }] });
  assert.equal(validateFigureAnalysis(bad, '').panels.length, 0, '越界被剔除');
  const tiny = mkAnalysis({ panels: [{ ...base, x: 0.1, y: 0.1, width: 0.05, height: 0.5 }] });
  assert.equal(validateFigureAnalysis(tiny, '').panels.length, 0, '过小被剔除');
  const ok = mkAnalysis({ panels: [{ ...base, x: 0.1, y: 0.1, width: 0.4, height: 0.4 }] });
  assert.equal(validateFigureAnalysis(ok, '').panels.length, 1, '合法子图保留');
  // 局部 OCR 核验不到标记/标签时剔除（防编造子图）
  const unverified = mkAnalysis({ panels: [{ ...base, ocrText: '完全无关的文字', x: 0.1, y: 0.1, width: 0.4, height: 0.4 }] });
  assert.equal(validateFigureAnalysis(unverified, '').panels.length, 0, '未被局部 OCR 核验的子图应剔除');
});

test('可用性：至少 2 节点 + 1 条边才可渲染', () => {
  assert.equal(figureUsable(mkAnalysis({ nodes: [{ id: 'a', label: 'A', kind: 'module' }], edges: [] })), false);
  assert.equal(figureUsable(mkAnalysis({ nodes: [{ id: 'a', label: 'A', kind: 'module' }, { id: 'b', label: 'B', kind: 'module' }], edges: [{ from: 'a', to: 'b' }] })), true);
});

test('分层：优先用模型给的 layer，缺失时最长路径松弛且不因环死循环', () => {
  const nodes = [{ id: 'a', label: 'A', kind: 'module', layer: null }, { id: 'b', label: 'B', kind: 'module', layer: null }, { id: 'c', label: 'C', kind: 'module', layer: null }];
  const depth = figureLayers(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
  assert.equal(depth.c, 2, '最长路径分层');

  // 环：a->b->a，必须终止
  const cyc = figureLayers(
    [{ id: 'a', label: 'A', kind: 'module' }, { id: 'b', label: 'B', kind: 'module' }],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  );
  assert.ok(Number.isFinite(cyc.a) && Number.isFinite(cyc.b), '有环也终止');
});

test('布局：节点落在画布内，箭头连接对应节点', () => {
  const nodes = [{ id: 'a', label: 'Input', kind: 'input', layer: null }, { id: 'b', label: 'Net', kind: 'module', layer: null }];
  const r = layoutFigure(nodes, [{ from: 'a', to: 'b' }], 600, 300, false);
  assert.equal(r.placed.length, 2);
  assert.equal(r.arrows.length, 1);
  assert.ok(r.placed.every((p) => p.x >= 0 && p.y >= 0 && p.x + p.width <= 600 && p.y + p.height <= 300));
  assert.equal(r.layerCount, 2);
});

test('布局：画布过小返回空，不抛错', () => {
  assert.deepEqual(layoutFigure([{ id: 'a', label: 'A', kind: 'module' }], [], 20, 20, false), { placed: [], arrows: [], layerCount: 0 });
});

test('布局：非法/重复 ID 的边被安全跳过', () => {
  const r = layoutFigure([{ id: 'a', label: 'A', kind: 'module' }], [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'a' }], 400, 200, false);
  assert.equal(r.arrows.length, 0, '引用不存在节点的边被跳过');
});

test('SVG 渲染转义标签，不产生可注入标签', () => {
  const svg = figureSVG(layoutFigure([{ id: 'a', label: '<img onerror=x>', kind: 'module' }], [], 400, 200, false), 400, 200);
  assert.ok(!svg.includes('<img'), '标签必须转义');
  assert.ok(svg.includes('&lt;img'));
});

test('decode：剥离夹带说明，缺 nodes/edges 报错', () => {
  const ok = decodeFigureAnalysis('结果如下：\n{"page":2,"title":"F","nodes":[],"edges":[]}\n完');
  assert.equal(ok.page, 2);
  assert.throws(() => decodeFigureAnalysis('{"page":1}'), /缺少 nodes/);
});

test('decode：模型缺字段时不给默认值猜测，用安全空值', () => {
  const a = decodeFigureAnalysis('{"nodes":[{"id":"a"}],"edges":[{}]}');
  assert.equal(a.nodes[0].label, '', '缺 label 就是空，由校验剔除');
  assert.equal(a.nodes[0].kind, 'module');
  assert.equal(a.edges[0].from, '');
});
