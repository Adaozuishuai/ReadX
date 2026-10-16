import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPaperHeadings, mergePaperHeadings } from './outline.js';

test('detect numbered, Roman and unnumbered headings without indexing paragraphs or captions', () => {
  const lines = ['1 Introduction', '2.1 Network architecture', 'III. EXPERIMENTS', 'A. Datasets', 'References', 'Fig. 3. Reconstruction quality', 'This is an ordinary paragraph about reconstruction with many words and no heading.'];
  const headings = detectPaperHeadings(lines.map((text, index) => ({ text, x: 40, y: 100 + index * 40, width: 250, height: 10 })), 2, 800);
  assert.deepEqual(headings.map((heading) => heading.title), lines.slice(0, 5));
  assert.equal(headings[1]!.depth, 1);
  assert.equal(headings[2]!.page, 2);
  assert.equal(headings[0]!.y, 0.125);
});

test('supplement title-only bookmarks and deduplicate section headings with exact anchors', () => {
  const result = mergePaperHeadings([{ title: 'A paper title', page: 1, depth: 0 }, { title: '1 Introduction', page: 1, depth: 0 }], [{ title: '1 Introduction', page: 1, depth: 0, y: 0.6 }, { title: '2 Method', page: 2, depth: 0, y: 0.2 }]);
  assert.equal(result.length, 3);
  assert.equal(result[1]!.y, 0.6);
});

test('exclude running author headers, small table labels and bibliography entries', () => {
  const candidates = detectPaperHeadings([
    { text: 'R. Zha et al.', x: 40, y: 100, width: 90, height: 10 },
    { text: 'method', x: 80, y: 400, width: 40, height: 8 },
    { text: 'This is ordinary body text with sufficient length to establish the normal font size.', x: 40, y: 200, width: 400, height: 10 },
  ], 2, 800);
  assert.equal(candidates.length, 0);
  const entries = mergePaperHeadings([], [
    { title: 'References', page: 6, depth: 0, y: 0.4 },
    { title: '5. Biguri, A., Dosanjh, M.', page: 6, depth: 0, y: 0.6 },
    { title: '055010 (2016)', page: 7, depth: 0, y: 0.1 },
    { title: 'Appendix A', page: 8, depth: 0, y: 0.1 },
    { title: 'A. Implementation', page: 8, depth: 1, y: 0.3 },
  ]);
  assert.deepEqual(entries.map((entry) => entry.title), ['References', 'Appendix A', 'A. Implementation']);
});

test('a complete native outline keeps its hierarchy while gaining precise anchors', () => {
  const result = mergePaperHeadings([
    { title: 'I. Introduction', page: 1, depth: 0 },
    { title: 'A. Methods', page: 2, depth: 1 },
    { title: 'III. Results', page: 3, depth: 0 },
  ], [
    { title: 'A. Methods', page: 2, depth: 0, y: 0.4 },
    { title: 'Method', page: 2, depth: 0, y: 0.7 },
    { title: '2 represents a certain norm', page: 2, depth: 0, y: 0.8 },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[1]!.depth, 1);
  assert.equal(result[1]!.y, 0.4);
});
