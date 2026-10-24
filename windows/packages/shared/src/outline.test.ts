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

test('exclude first-page numbered affiliations while retaining sections about universities', () => {
  const headings = detectPaperHeadings([
    { text: '1 University of Illinois Urbana-Champaign', x: 0.36, y: 204, width: 220, height: 10 },
    { text: '2 Australian National University', x: 0.39, y: 215, width: 190, height: 10 },
    { text: '3 Johns Hopkins University', x: 0.41, y: 226, width: 170, height: 10 },
    { text: 'Abstract. Sparse-view computed tomography is critical for reducing radiation exposure.', x: 0.22, y: 290, width: 350, height: 10 },
    { text: '1 Introduction', x: 0.22, y: 567, width: 100, height: 12 },
    { text: '2 University Research Partnerships', x: 0.22, y: 650, width: 220, height: 12 },
  ], 1, 800);
  assert.deepEqual(headings.map((heading) => heading.title), ['1 Introduction', '2 University Research Partnerships']);
});

test('exclude numbered project links, contact details and bibliography author lists', () => {
  const titles = [
    '1 Project page: perturbed-gaussian-ensemble.cvmlgroup.web.illinois.edu',
    '2 https://github.com/example/research',
    '3 Contact: author@university.edu',
    '11. Chen, X., Li, Q., Wang, T., Xue, T., Pang, J.: Gennbv: Generalizable next-best-',
    '12. Chung, H., Ryu, D., McCann, M.T., Klasky, M.L., Ye, J.C.: Solving 3d inverse',
    '4.2 Results',
  ];
  const headings = detectPaperHeadings(titles.map((text, index) => ({ text, x: 0.22, y: 100 + index * 40, width: 350, height: 10 })), 3, 800);
  assert.deepEqual(headings.map((heading) => heading.title), ['4.2 Results']);
});

test('bibliography filtering tolerates PDF alignment noise in the same column', () => {
  const entries = mergePaperHeadings([], [
    { title: '5 Conclusion', page: 15, depth: 0, x: 0.220204, y: 0.2, sectionPath: [5] },
    { title: 'References', page: 16, depth: 0, x: 0.220204, y: 0.15 },
    { title: '11. Chen, X., Li, Q.', page: 16, depth: 0, x: 0.220202, y: 0.58, sectionPath: [11] },
    { title: '374. Springer (2025)', page: 17, depth: 0, x: 0.22, y: 0.3, sectionPath: [374] },
    { title: 'Appendix A', page: 18, depth: 0, x: 0.22, y: 0.1 },
  ]);
  assert.deepEqual(entries.map((entry) => entry.title), ['5 Conclusion', 'References', 'Appendix A']);
});

test('two-column numbered sections keep left-column 3 and 3.1 before right-column 3.2', () => {
  const entries = mergePaperHeadings([], [
    { title: '3.2 Test-Time Training Model', page: 3, depth: 1, x: 0.55, y: 0.1, sectionPath: [3, 2] },
    { title: '3 Preliminaries', page: 3, depth: 0, x: 0.08, y: 0.6, sectionPath: [3] },
    { title: '3.1 Attention Mechanism', page: 3, depth: 1, x: 0.08, y: 0.7, sectionPath: [3, 1] },
  ]);
  assert.deepEqual(entries.map((entry) => entry.title), ['3 Preliminaries', '3.1 Attention Mechanism', '3.2 Test-Time Training Model']);
});
