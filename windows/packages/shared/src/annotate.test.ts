import assert from 'node:assert/strict';
import test from 'node:test';

import { annotationSpans, annotationsForPage, segmentParagraph } from './annotate.js';

const annotation = (id: string, quote: string, over: Partial<{ kind: string; color: string; page: number | null }> = {}) => ({
  id,
  quote,
  kind: over.kind ?? 'highlight',
  color: over.color ?? 'amber',
  page: over.page === undefined ? 1 : over.page,
});

test('segmentParagraph：命中的摘录被单独切成一段', () => {
  const segments = segmentParagraph('We train using 50 views and report PSNR.', [annotation('a1', 'using 50 views')]);
  assert.deepEqual(segments.map((s) => s.text), ['We train ', 'using 50 views', ' and report PSNR.']);
  assert.equal(segments[1]?.annotationId, 'a1');
  assert.equal(segments[1]?.color, 'amber');
});

test('segmentParagraph：空白差异不影响命中', () => {
  const segments = segmentParagraph('sparse-view CBCT   reconstruction\npipeline', [annotation('b1', 'sparse-view CBCT reconstruction')]);
  const marked = segments.find((s) => s.annotationId === 'b1');
  assert.ok(marked, '应命中被空白差异打散的摘录');
  assert.equal(marked?.text, 'sparse-view CBCT   reconstruction');
});

test('segmentParagraph：无命中时原样返回单段', () => {
  assert.deepEqual(segmentParagraph('普通正文', [annotation('c1', '不存在的话')]), [{ text: '普通正文' }]);
  assert.deepEqual(segmentParagraph('', [annotation('c1', 'x')]), []);
});

test('segmentParagraph：长摘录优先，重叠的短摘录不切开它', () => {
  const segments = segmentParagraph('NAF achieves 33.05 dB while FDK reaches 29.10 dB', [
    annotation('short', 'achieves 33.05', { color: 'sky' }),
    annotation('long', 'NAF achieves 33.05 dB', { color: 'rose' }),
  ]);
  const ids = segments.filter((s) => s.annotationId).map((s) => s.annotationId);
  assert.deepEqual(ids, ['long']);
  assert.equal(segments.find((s) => s.annotationId === 'long')?.color, 'rose');
});

test('annotationSpans：一条批注只标第一处命中，重复短语不被连带标注', () => {
  const spans = annotationSpans('alpha beta gamma beta delta', [
    annotation('x', 'beta', { color: 'amber' }),
    annotation('y', 'gamma', { color: 'sky' }),
  ]);
  // 一条批注 = 一处选区。第二处 beta 是无关复现，标上会让「我到底圈了哪句」失真。
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => s.id), ['x', 'y']);
  for (let i = 1; i < spans.length; i++) {
    assert.ok((spans[i - 1] as { end: number }).end <= (spans[i] as { start: number }).start, '区间不得重叠');
  }
});

test('annotationsForPage：未标页码的批注不参与正文高亮', () => {
  const list = [annotation('p1', 'a', { page: 1 }), annotation('p2', 'b', { page: 2 }), annotation('none', 'c', { page: null })];
  assert.deepEqual(annotationsForPage(list, 1).map((a) => a.id), ['p1']);
  assert.deepEqual(annotationsForPage(list, null), []);
});
