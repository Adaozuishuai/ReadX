// 系统标签移植保真回归：把 native/Tests/CBCTReadingTests/SystemTagTests.swift 的断言
// 逐条翻成 TS，并额外锁死「八类关键词表一字不差」。
// 任何一条失败都说明移植改变了语义，而不是「测试太严」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYSTEM_TAG_CATEGORIES, SystemTagCategory, SystemTag, vocabulary, derive, coverage,
  tagFields, categoryLabel,
} from '../core/systemTags';
import { QueueEntry } from '../core/types';

const id = (t: SystemTag): string => t.category + '|' + t.value;

// ---------------------------------------------------------------------------
// 词表逐字保真：直接从 Swift 源码誊写，任何增删改词都会让这条测试失败。
// 这是「八类关键词表每个词条一字不差搬过来」的机器可验证版本。
// ---------------------------------------------------------------------------
const SWIFT_VOCABULARY: Record<string, Record<string, string[]>> = {
  Task: {
    'Sparse-view': ['sparse-view', 'sparse view', 'few-view', 'few view', 'limited-angle'],
    'Low-dose': ['low-dose', 'low dose', 'low-mas', 'low mas', 'dose reduction'],
    '4D-CBCT': ['4d-cbct', '4d cbct', 'dynamic cbct', 'motion'],
    'Artifact Removal': ['artifact', 'artefact', 'metal artifact', 'scatter correction'],
    'Projection Completion': ['projection completion', 'sinogram completion', 'inpainting'],
    'Super-resolution': ['super-resolution', 'super resolution', 'superresolution'],
  },
  Domain: {
    Projection: ['sinogram', 'projection domain', 'raw projection'],
    Image: ['image domain', 'image-domain', 'post-processing'],
    'Dual-domain': ['dual-domain', 'dual domain'],
    'Implicit 3D': ['implicit', 'neural field', 'neural radiance', 'attenuation field'],
  },
  Acquisition: {
    Circular: ['circular', 'full-scan', '360'],
    'Limited-angle': ['limited-angle', 'limited angle', '45°', 'limited angular'],
    'Real scan': ['real data', 'real-world', 'patient', 'clinical'],
    Simulated: ['simulated', 'simulation', 'tigre', 'synthetic'],
  },
  Architecture: {
    CNN: ['convolutional', 'cnn', 'u-net', 'unet'],
    Transformer: ['transformer', 'attention', 'vit'],
    MLP: ['mlp', 'multi-layer perceptron', 'multilayer perceptron'],
    Diffusion: ['diffusion', 'score-based', 'denoising diffusion'],
    Gaussian: ['gaussian splatting', '3d gaussian', 'gaussian representation'],
    'Hash Grid': ['hash encoding', 'hash grid', 'instant-ngp', 'multiresolution hash'],
  },
  'Learning Paradigm': {
    Supervised: ['supervised', 'ground truth supervision'],
    'Self-supervised': ['self-supervised', 'self supervised', 'unsupervised', 'without training data'],
    'Per-case Optimization': ['per-case', 'per case', 'per-subject', 'per-patient'],
    'Test-time Adaptation': ['test-time', 'test time', 'scan-adaptive', 'tta'],
  },
  Dataset: {
    Walnut: ['walnut'],
    LUNA16: ['luna16', 'luna-16'],
    AAPM: ['aapm', 'low dose ct grand challenge'],
    'LIDC-IDRI': ['lidc', 'lidc-idri'],
    TIGRE: ['tigre'],
    'Real Phantom': ['phantom'],
  },
  Metric: {
    PSNR: ['psnr', 'peak signal-to-noise'],
    SSIM: ['ssim', 'structural similarity'],
    RMSE: ['rmse', 'root mean square'],
    MAE: ['mae', 'mean absolute error'],
    LPIPS: ['lpips'],
  },
  Venue: {
    MICCAI: ['miccai'],
    CVPR: ['cvpr'],
    ICCV: ['iccv'],
    ECCV: ['eccv'],
    NeurIPS: ['neurips', 'nips'],
    'IEEE TMI': ['ieee transactions on medical imaging', 'tmi'],
    'Medical Physics': ['medical physics'],
    'Physics in Medicine & Biology': ['physics in medicine'],
  },
};

test('PRD 7.2：系统标签恰好八类，类别值序列与 Swift allCases 一致', () => {
  assert.equal(SYSTEM_TAG_CATEGORIES.length, 8);
  assert.deepEqual([...SYSTEM_TAG_CATEGORIES], [
    'Task', 'Domain', 'Acquisition', 'Architecture',
    'Learning Paradigm', 'Dataset', 'Metric', 'Venue',
  ]);
  for (const category of SYSTEM_TAG_CATEGORIES) {
    assert.equal(categoryLabel(category), category);
    assert.ok(vocabulary[category], '缺少类别词表：' + category);
    assert.ok(Object.keys(vocabulary[category]).length > 0, '类别词表为空：' + category);
  }
});

test('八类关键词表每个词条与 Swift 源码逐字一致（含顺序）', () => {
  assert.deepEqual(Object.keys(vocabulary), [...SYSTEM_TAG_CATEGORIES]);
  assert.deepEqual(vocabulary, SWIFT_VOCABULARY);
  // 再逐数组比对一次，失败时能直接指出是哪个标签的词条被改动。
  for (const category of SYSTEM_TAG_CATEGORIES) {
    for (const [label, cues] of Object.entries(SWIFT_VOCABULARY[category])) {
      assert.deepEqual(vocabulary[category][label], cues, `${category}|${label} 线索词被改动`);
    }
    assert.deepEqual(
      Object.keys(vocabulary[category]).sort(),
      Object.keys(SWIFT_VOCABULARY[category]).sort(),
      `${category} 标签集合被改动`,
    );
  }
});

test('系统标签能从论文文本派生（Swift testSystemTagsDeriveFromPaperText）', () => {
  const fields = [
    'Sparse-view CBCT reconstruction with implicit neural fields',
    'We use hash encoding and a small MLP. Trained self-supervised on LUNA16 with PSNR and SSIM.',
    'MICCAI 2022', 'simulated projections via TIGRE',
  ];
  const tags = derive(fields);
  const pairs = tags.map(id);
  for (const expected of [
    'Task|Sparse-view', 'Domain|Implicit 3D', 'Architecture|MLP', 'Architecture|Hash Grid',
    'Learning Paradigm|Self-supervised', 'Dataset|LUNA16', 'Metric|PSNR', 'Metric|SSIM',
    'Venue|MICCAI', 'Acquisition|Simulated',
  ]) {
    assert.ok(pairs.includes(expected), '缺少标签：' + expected + '，实得 ' + pairs.join(', '));
  }
  // 命中项必须带证据词，否则用户无法核对
  for (const tag of tags) assert.ok(tag.evidence.length > 0, '缺少依据：' + tag.value);
  // 类内按 value 字典序、类间按 allCases 顺序（Swift sorted(by: key) + allCases 循环）
  assert.deepEqual(pairs, [
    'Task|Sparse-view',
    'Domain|Implicit 3D',
    'Acquisition|Simulated',
    'Architecture|Hash Grid',
    'Architecture|MLP',
    'Learning Paradigm|Self-supervised',
    'Learning Paradigm|Supervised', // "self-supervised" 里含 "supervised"：Swift 子串匹配的既有语义
    'Dataset|LUNA16',
    'Dataset|TIGRE',
    'Metric|PSNR',
    'Metric|SSIM',
    'Venue|MICCAI',
  ]);
});

test('命不中就不输出——绝不推测（evidence-first）', () => {
  assert.deepEqual(derive([]), []);
  assert.deepEqual(derive(['']), []);
  assert.deepEqual(derive(['a paper about nothing in particular']), []);
  // 只提到 PSNR，就不能同时冒出 SSIM/RMSE
  const onlyPsnr = derive(['we report PSNR']);
  assert.deepEqual(onlyPsnr.filter((t) => t.category === 'Metric').map((t) => t.value), ['PSNR']);
  assert.deepEqual(onlyPsnr.map(id), ['Metric|PSNR']);
  // 空白字段也不能凭空产生标签
  assert.deepEqual(derive(['   ', '\n', '\t']), []);
});

test('derive 大小写不敏感（字段整体 lowercase 后匹配）', () => {
  const upper = derive(['SPARSE-VIEW CBCT with IMPLICIT NEURAL FIELDS, PSNR/SSIM on LUNA16 at MICCAI']);
  const lower = derive(['sparse-view cbct with implicit neural fields, psnr/ssim on luna16 at miccai']);
  const mixed = derive(['SpArSe-ViEw cbct with Implicit Neural Fields, PsNr/SsIm on LuNa16 at MicCaI']);
  assert.deepEqual(upper, lower);
  assert.deepEqual(mixed, lower);
  assert.deepEqual(lower.map(id), [
    'Task|Sparse-view', 'Domain|Implicit 3D', 'Dataset|LUNA16',
    'Metric|PSNR', 'Metric|SSIM', 'Venue|MICCAI',
  ]);
  // 大写的证据词必须仍然是词表里的原始小写线索
  assert.equal(derive(['SPARSE-VIEW'])[0].evidence, 'sparse-view');
});

test('同一 value 只输出一次，且结果顺序稳定', () => {
  const fields = ['sparse-view sparse view few-view', 'psnr PSNR PSNR'];
  const tags = derive(fields);
  const ids = tags.map(id);
  assert.equal(ids.length, new Set(ids).size, '出现重复标签');
  assert.deepEqual(derive(fields), tags);
  assert.deepEqual(ids, ['Task|Sparse-view', 'Metric|PSNR']);
  // 依据词是线索数组里第一个命中的那个（稀疏视角线索首项是 sparse-view）
  assert.equal(tags[0].evidence, 'sparse-view');
});

test('evidence 取该标签线索数组里第一个命中的词（Swift cues.first(where:)）', () => {
  assert.equal(derive(['few-view'])[0].evidence, 'few-view');
  assert.equal(derive(['limited-angle'])[0].category, 'Task');
  assert.equal(derive(['limited-angle']).find((t) => t.category === 'Task')?.evidence, 'limited-angle');
  assert.equal(derive(['artefact'])[0].evidence, 'artefact');
  assert.equal(derive(['nips'])[0].value, 'NeurIPS');
  assert.equal(derive(['luna-16'])[0].evidence, 'luna-16');
});

test('coverage 给出每类命中数，且能定位缺失类别', () => {
  const tags = derive(['Sparse-view with PSNR and SSIM']);
  const cov = coverage(tags);
  assert.equal(cov.length, 8);
  assert.deepEqual(cov, [
    ['Task', 1], ['Domain', 0], ['Acquisition', 0], ['Architecture', 0],
    ['Learning Paradigm', 0], ['Dataset', 0], ['Metric', 2], ['Venue', 0],
  ]);
  const missing = cov.filter(([, n]) => n === 0).map(([c]) => c as SystemTagCategory);
  assert.ok(missing.includes('Venue'));
  assert.ok(!missing.includes('Metric'));
});

test('tagFields 汇总 title/abstract/venue/why，跳过空字段并保持 Swift 顺序', () => {
  const paper: QueueEntry = {
    title: 'T', abstract: 'A', venue: 'V', why: 'W',
    authors: ['x'], year: '2024', id: 'i',
  };
  assert.deepEqual(tagFields(paper), ['T', 'A', 'V', 'W']);
  assert.deepEqual(tagFields({ title: null, abstract: '', venue: 'ICCV' }), ['ICCV']);
  assert.deepEqual(tagFields({}), []);
  // 空论文不得产生任何系统标签
  assert.deepEqual(derive(tagFields({ id: 'empty-paper', title: null, authors: null, venue: null })), []);
});
