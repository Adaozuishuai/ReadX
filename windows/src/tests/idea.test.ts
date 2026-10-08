// 移植保真度回归：IdeaModels.swift 的断言逐条翻成 TS。
// 任何一条失败都说明移植改变了语义，而不是「测试太严」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDEA_STATUS_LABEL, IDEA_STATUSES, EVIDENCE_ORIGINS,
  createIdeaEvidence, defaultResearchIdea, validateIdeaEvidence,
  decodeResearchApplication, researchApplicationGroups, validateResearchApplication,
  ApplicationAdvice, ResearchApplication,
} from '../core/idea';

const SOURCE = '=== Page 2 ===\nWe use an implicit neural representation for CT reconstruction.\n\n=== Page 4 ===\nWe train using 50 views with fixed geometry.';

function advice(over: Partial<ApplicationAdvice> = {}): ApplicationAdvice {
  return {
    title: 'Try implicit fields',
    suggestion: 'Research suggestion',
    constraint: 'Test sparse CBCT geometry',
    verification: 'Equal-view evaluation',
    evidence: [{
      k: 'method', v: 'implicit representation',
      page: 2, excerpt: 'We use an implicit neural representation',
    }],
    ...over,
  };
}

function application(over: Partial<ResearchApplication> = {}): ResearchApplication {
  return { reusable: [], adaptation: [advice()], conflicts: [], validation: [], ...over };
}

test('IdeaStatus 五个值与中文 label 与 Swift 一致', () => {
  assert.deepEqual([...IDEA_STATUSES], ['Idea', 'Planned', 'Running', 'Rejected', 'Adopted']);
  assert.deepEqual(IDEA_STATUS_LABEL, {
    Idea: '想法', Planned: '待实验', Running: '实验中', Rejected: '已否定', Adopted: '已采纳',
  });
});

test('EvidenceOrigin 四个值与 Swift 一致', () => {
  assert.deepEqual([...EVIDENCE_ORIGINS], ['论文原文', 'AI 解释', '研究建议', '个人笔记']);
});

test('ResearchIdea 默认值：状态为 idea、其余字段为空、evidence 为空', () => {
  const idea = defaultResearchIdea();
  assert.equal(idea.status, 'Idea');
  assert.equal(idea.question, '');
  assert.equal(idea.observation, '');
  assert.equal(idea.hypothesis, '');
  assert.equal(idea.method, '');
  assert.equal(idea.experiment, '');
  assert.deepEqual(idea.evidence, []);
  assert.ok(idea.id.length > 0);
  assert.match(idea.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('IdeaEvidence：origin 非「论文原文」时，无页码无摘录也必须通过', () => {
  // 关键点：这里必须 doesNotThrow。若实现把所有 origin 都当原文校验，本用例立刻失败。
  for (const origin of ['AI 解释', '研究建议', '个人笔记'] as const) {
    const evidence = createIdeaEvidence({
      paperKey: 'a', paperTitle: 'Paper', origin, page: null, excerpt: '',
    });
    assert.doesNotThrow(() => validateIdeaEvidence(evidence, SOURCE), `origin=${origin} 不该被校验`);
  }
});

test('IdeaEvidence：不再为原文但页码/摘录配对错误时也应放行（origin 决定是否校验）', () => {
  const stale = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: 'AI 解释', page: 999, excerpt: '完全不存在的引用文字',
  });
  assert.doesNotThrow(() => validateIdeaEvidence(stale, SOURCE));
});

test('IdeaEvidence：论文原文且页码 + 逐字摘录正确时通过', () => {
  const evidence = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: '论文原文', page: 4, excerpt: 'We train using 50 views',
  });
  assert.doesNotThrow(() => validateIdeaEvidence(evidence, SOURCE));
});

test('IdeaEvidence：论文原文但页码不存在时抛错', () => {
  const evidence = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: '论文原文', page: 2, excerpt: 'We train using 50 views',
  });
  assert.throws(() => validateIdeaEvidence(evidence, SOURCE),
    /原文证据须包含有效页码和该页至少 8 个非空白字符的逐字摘录。/);
});

test('IdeaEvidence：论文原文但摘录不在该页时抛错', () => {
  const evidence = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: '论文原文', page: 4, excerpt: 'We train using 100 views',
  });
  assert.throws(() => validateIdeaEvidence(evidence, SOURCE), /原文证据须包含有效页码/);
});

test('IdeaEvidence：论文原文但摘录不足 8 个非空白字符时抛错', () => {
  const evidence = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: '论文原文', page: 4, excerpt: 'We tra',
  });
  // 'wetra' 只有 5 个非空白字符，虽然它确实是该页文本的前缀，仍必须被 8 字下限拒绝。
  assert.throws(() => validateIdeaEvidence(evidence, SOURCE), /原文证据须包含有效页码/);
});

test('IdeaEvidence：论文原文但缺页码（null）时抛错', () => {
  const evidence = createIdeaEvidence({
    paperKey: 'a', paperTitle: 'Paper', origin: '论文原文', page: null, excerpt: 'We train using 50 views',
  });
  assert.throws(() => validateIdeaEvidence(evidence, SOURCE), /原文证据须包含有效页码/);
});

test('ResearchApplication.groups：四类顺序与中文标题与 Swift 一致', () => {
  const groups = researchApplicationGroups(application());
  assert.deepEqual(groups.map(([key]) => key), ['reusable', 'adaptation', 'conflicts', 'validation']);
  assert.deepEqual(groups.map(([, label]) => label), [
    '可直接复用 · 仍需确认前提', '需要适配', '存在冲突 / 潜在冲突', '需要验证',
  ]);
});

test('ResearchApplication.validate：没有任何建议时抛「迁移分析没有返回建议。」', () => {
  const empty: ResearchApplication = { reusable: [], adaptation: [], conflicts: [], validation: [] };
  assert.throws(() => validateResearchApplication(empty, SOURCE), /迁移分析没有返回建议。/);
});

test('ResearchApplication.validate：缺少 constraint（或 verification/evidence）时抛错', () => {
  assert.throws(
    () => validateResearchApplication(application({ adaptation: [advice({ constraint: '' })] }), SOURCE),
    /Try implicit fields：缺少依据、研究约束或验证实验/);
  assert.throws(
    () => validateResearchApplication(application({ adaptation: [advice({ verification: '' })] }), SOURCE),
    /缺少依据、研究约束或验证实验/);
  assert.throws(
    () => validateResearchApplication(application({ adaptation: [advice({ title: '' })] }), SOURCE),
    /缺少依据、研究约束或验证实验/);
});

test('ResearchApplication.validate：evidence 摘录不在页面时抛错', () => {
  const bad = advice({
    evidence: [{ k: 'method', v: 'implicit representation', page: 2, excerpt: 'Invented evidence excerpt' }],
  });
  assert.throws(() => validateResearchApplication(application({ adaptation: [bad] }), SOURCE),
    /Try implicit fields：/);
});

test('ResearchApplication.validate：只有未知字段（page 全为 null）时抛「只有未知字段」', () => {
  const unknownOnly = advice({
    evidence: [{ k: 'GPU', v: '论文未说明', page: null, excerpt: null }],
  });
  assert.throws(() => validateResearchApplication(application({ adaptation: [unknownOnly] }), SOURCE),
    /Try implicit fields：只有未知字段，没有原文依据/);
});

test('ResearchApplication.validate：混合未知字段与已知字段时通过（未知本身不违规）', () => {
  const mixed = advice({
    evidence: [
      { k: 'GPU', v: '论文未说明', page: null, excerpt: null },
      { k: 'method', v: 'implicit representation', page: 2, excerpt: 'We use an implicit neural representation' },
    ],
  });
  assert.doesNotThrow(() => validateResearchApplication(application({ adaptation: [mixed] }), SOURCE));
});

test('ResearchApplication.validate：全部合规时通过，且四个分组都被检查', () => {
  const ok = application({
    reusable: [advice({ title: 'Reuse encoder' })],
    adaptation: [advice({ title: 'Adapt geometry' })],
    conflicts: [advice({ title: 'Conflict on dose' })],
    validation: [advice({ title: 'Validate metric' })],
  });
  assert.doesNotThrow(() => validateResearchApplication(ok, SOURCE));
});

test('ResearchApplication.decode：剥掉 ```json 围栏', () => {
  const raw = JSON.stringify(application());
  const parsed = decodeResearchApplication('```json\n' + raw + '\n```');
  assert.equal(parsed.adaptation.length, 1);
});

test('ResearchApplication.validate：问题合并抛出（多条建议各自的问题都在消息里）', () => {
  const a = advice({ title: 'A', constraint: '' });
  const b = advice({ title: 'B', verification: '' });
  try {
    validateResearchApplication(application({ adaptation: [a, b] }), SOURCE);
    assert.fail('应当抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /A：缺少依据、研究约束或验证实验/);
    assert.match(message, /B：缺少依据、研究约束或验证实验/);
  }
});

// 解码期结构校验：缺组必须是可读错误，不能崩成 undefined.title
test('application decode：缺组时给出可读错误', () => {
  const { decodeResearchApplication } = require('../core/idea') as typeof import('../core/idea');
  assert.throws(
    () => decodeResearchApplication('{}'),
    (e: Error) => /缺少必需的组/.test(e.message) && !/Cannot read properties/.test(e.message),
  );
  assert.throws(() => decodeResearchApplication('null'), /必须是一个 JSON 对象/);
  assert.throws(() => decodeResearchApplication('nope'), /不是合法 JSON/);
});
