// 引用导出回归：逐条对应早期 macOS（Swift）版 CitationExport.swift。
// 每条断言都能真正失败（不存在恒真断言）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  bibtexEscaped, citationKey, bibtexAuthor, year, isArxiv,
  bibtex, ris, bibtexAll, risAll, suggestedFilename,
} from '../core/citation';
import { QueueEntry } from '../core/types';
import { findRoot } from '../core/store';
import { decodeQueue } from '../core/paper';

const ROOT = findRoot(__dirname);

// ---------- bibtexEscaped：十个特殊字符逐个断言 ----------

test('bibtexEscaped 逐字符映射与 Swift 完全一致', () => {
  assert.equal(bibtexEscaped('\\'), '\\textbackslash{}');
  assert.equal(bibtexEscaped('&'), '\\&');
  assert.equal(bibtexEscaped('%'), '\\%');
  assert.equal(bibtexEscaped('$'), '\\$');
  assert.equal(bibtexEscaped('#'), '\\#');
  assert.equal(bibtexEscaped('_'), '\\_');
  assert.equal(bibtexEscaped('{'), '\\{');
  assert.equal(bibtexEscaped('}'), '\\}');
  assert.equal(bibtexEscaped('~'), '\\textasciitilde{}');
  assert.equal(bibtexEscaped('^'), '\\textasciicircum{}');
});

test('bibtexEscaped 普通字符原样保留，混合串顺序不变', () => {
  assert.equal(bibtexEscaped('abc'), 'abc');
  assert.equal(bibtexEscaped('a&b_c'), 'a\\&b\\_c');
  // 若把 \textasciitilde{} 写成 \textasciitilde 或多加了 {}，此断言失败
  assert.equal(bibtexEscaped('100%~'), '100\\%\\textasciitilde{}');
});

// ---------- citationKey ----------

test("citationKey 对含点号的 arXiv 号不加 ref 前缀（历史 bug 回归点）", () => {
  assert.equal(citationKey({ arxiv: '2209.14540' }), '2209.14540');
  // 带版本号的 arXiv 号同理，含点号即不加前缀
  assert.equal(citationKey({ arxiv: '2209.14540v2' }), '2209.14540v2');
});

test('citationKey 对完全由数字组成的键加 ref 前缀', () => {
  assert.equal(citationKey({ id: '12345' }), 'ref12345');
  assert.equal(citationKey({ arxiv: '12345' }), 'ref12345');
});

test('citationKey 优先级 arxiv > id > title，且清理非法字符', () => {
  assert.equal(citationKey({ arxiv: '2209.14540', id: 'zzz', title: 'T' }), '2209.14540');
  assert.equal(citationKey({ id: 'intratomo-2021', title: 'T' }), 'intratomo-2021');
  // ':' 是允许保留的字符，空格与 '!' 被清掉
  assert.equal(citationKey({ title: 'A Study: of Things!' }), 'AStudy:ofThings');
  // 保留 . : -，去掉 ! 空格 / 等
  assert.equal(citationKey({ id: 'a/b c!d:e-f.g' }), 'abcd:e-f.g');
});

test('citationKey 清理后为空时回退为 paper（不是 refpaper）', () => {
  assert.equal(citationKey({ id: '!!!' }), 'paper');
  assert.equal(citationKey({}), 'paper');
});

test('citationKey 的 arxiv 为空串时回退到 id', () => {
  assert.equal(citationKey({ arxiv: '', id: 'x1' }), 'x1');
});

// ---------- bibtexAuthor ----------

test('bibtexAuthor：First Last → Last, First', () => {
  assert.equal(bibtexAuthor('Guangming Zang'), 'Zang, Guangming');
  // 中间名并入 First
  assert.equal(bibtexAuthor('John Ronald Reuel Tolkien'), 'Tolkien, John Ronald Reuel');
  // 前后空白先 trim
  assert.equal(bibtexAuthor('  Guangming Zang  '), 'Zang, Guangming');
});

test('bibtexAuthor：已含逗号原样返回，单段名字原样返回', () => {
  assert.equal(bibtexAuthor('Zang, Guangming'), 'Zang, Guangming');
  assert.equal(bibtexAuthor('Zang,Guangming'), 'Zang,Guangming');
  assert.equal(bibtexAuthor('Tolkien'), 'Tolkien');
  assert.equal(bibtexAuthor(''), '');
  assert.equal(bibtexAuthor('   '), '');
});

// ---------- year ----------

test('year 对 arXiv 日期格式取前 4 位数字', () => {
  assert.equal(year({ published: '2026-09-30' }), '2026');
  assert.equal(year({ published: '2026-09' }), '2026');
  assert.equal(year({ published: '2026' }), '2026');
  assert.equal(year({ published: '' }), '');
  assert.equal(year({}), '');
});

test('year 恰好 4 位数字才采用，否则回退到下一个候选', () => {
  assert.equal(year({ published: '2026x-01' }), '2026');
  assert.equal(year({ published: '26' }), '');
  assert.equal(year({ published: '26', year: '2021' }), '2021');
  assert.equal(year({ published: 'abcd', year: '2021' }), '2021');
  // published 优先于 year
  assert.equal(year({ published: '2019-01-01', year: '2021' }), '2019');
});

// ---------- bibtex ----------

test('bibtex 空字段整行不输出（不产生 author = {}）', () => {
  const out = bibtex({ id: 'k1', title: 'T' });
  assert.ok(out.includes('@article{k1,'), out);
  assert.ok(out.includes('  title = {{T}}'), out);
  assert.ok(!out.includes('author'), '无 authors 时不得出现 author 字段');
  // 不得出现任何空值字段行（author = {} / year = {} …）
  assert.ok(!/^\s*[A-Za-z]+ = \{\},?$/m.test(out), `不得出现空字段行：${out}`);
});

test('bibtex：arXiv 条目类型为 misc 且含 eprint / archivePrefix', () => {
  const out = bibtex({ arxiv: '2209.14540', title: 'A', authors: ['X Y'], published: '2022-09-29' });
  assert.ok(out.includes('@misc{2209.14540,'), out);
  assert.ok(out.includes('  eprint = {2209.14540}'), out);
  assert.ok(out.includes('  archivePrefix = {arXiv}'), out);
  assert.ok(out.includes('  year = {2022}'), out);
});

test('bibtex：venue 为 arXiv 时不输出 journal，其它 venue 输出', () => {
  const arxiv = bibtex({ arxiv: '2209.14540', title: 'A', venue: 'arXiv' });
  assert.ok(!arxiv.includes('journal'), arxiv);
  const conf = bibtex({ id: 'k', title: 'A', venue: 'ICCV 2021' });
  assert.ok(conf.includes('  journal = {ICCV 2021}'), conf);
  assert.ok(conf.includes('@article{k,'), conf);
});

test('bibtex：多作者用 and 连接，标题用花括号包裹并转义', () => {
  const out = bibtex({ id: 'k', title: 'A & B: 100% Study', authors: ['Guangming Zang', 'Ramzi Idoughi', 'Solo'] });
  assert.ok(out.includes('  author = {Zang, Guangming and Idoughi, Ramzi and Solo}'), out);
  assert.ok(out.includes('  title = {{A \\& B: 100\\% Study}}'), out);
});

test('bibtex：doi 与 pdfUrl 转义后输出', () => {
  const out = bibtex({ id: 'k', title: 'T', doi: '10.1000/a_b', pdfUrl: 'https://x.org/a_b.pdf' });
  assert.ok(out.includes('  doi = {10.1000/a\\_b}'), out);
  assert.ok(out.includes('  url = {https://x.org/a\\_b.pdf}'), out);
});

// ---------- ris ----------

test('ris：无标题退化为 TY - GEN', () => {
  const out = ris({ id: 'k', authors: ['X Y'] });
  assert.ok(out.startsWith('TY  - GEN\n'), out);
  assert.ok(!out.includes('TI  - '), '无标题时不得输出空 TI');
  assert.ok(out.endsWith('ER  - '), out);
});

test('ris：有标题非 arXiv 为 JOUR，arXiv 输出 AN 与 abs UR', () => {
  const plain = ris({ id: 'k', title: 'T', pdfUrl: 'https://x.org/p.pdf' });
  assert.ok(plain.startsWith('TY  - JOUR\n'), plain);
  assert.ok(plain.includes('UR  - https://x.org/p.pdf'), plain);

  const ax = ris({ arxiv: '2209.14540', title: 'T', pdfUrl: 'https://x.org/p.pdf' });
  assert.ok(ax.includes('AN  - arXiv:2209.14540'), ax);
  assert.ok(ax.includes('UR  - https://arxiv.org/abs/2209.14540'), ax);
  assert.ok(!ax.includes('https://x.org/p.pdf'), 'arXiv 条目 UR 不用 pdfUrl');
});

test('ris：字段行格式与顺序（TY/AU/TI/JO/PY/DO/ER）', () => {
  const out = ris({
    id: 'k', title: 'T', authors: ['Guangming Zang'], venue: 'ICCV 2021',
    published: '2021-10-01', doi: '10.1000/x',
  });
  assert.deepEqual(out.split('\n'), [
    'TY  - JOUR',
    'AU  - Zang, Guangming',
    'TI  - T',
    'JO  - ICCV 2021',
    'PY  - 2021',
    'DO  - 10.1000/x',
    'ER  - ',
  ]);
});

// ---------- 多条合并 / 文件名 ----------

test('bibtexAll / risAll：空集合返回空串，多条用空行分隔且末尾换行', () => {
  assert.equal(bibtexAll([]), '');
  assert.equal(risAll([]), '');
  const two = bibtexAll([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  assert.ok(two.includes('@article{a,'), two);
  assert.ok(two.includes('@article{b,'), two);
  assert.ok(two.includes('}\n\n@article{b,'), two);
  assert.ok(two.endsWith('\n'), two);
  assert.equal(two, bibtex({ id: 'a', title: 'A' }) + '\n\n' + bibtex({ id: 'b', title: 'B' }) + '\n');
});

test('suggestedFilename：单篇用引用键，多篇/零篇用日期', () => {
  assert.equal(suggestedFilename([{ arxiv: '2209.14540' }], 'bib', '2026-10-03'), '2209.14540.bib');
  assert.equal(suggestedFilename([{ id: '12345' }], 'ris', '2026-10-03'), 'ref12345.ris');
  assert.equal(suggestedFilename([{ id: 'a' }, { id: 'b' }], 'bib', '2026-10-03'), 'CBCT-citations-2026-10-03.bib');
  assert.equal(suggestedFilename([], 'bib', '2026-10-03'), 'CBCT-citations-2026-10-03.bib');
});

test('isArxiv：null / 空串为 false', () => {
  assert.equal(isArxiv({ arxiv: '2209.14540' }), true);
  assert.equal(isArxiv({ arxiv: '' }), false);
  assert.equal(isArxiv({}), false);
});

// ---------- 真实 queue.json 端到端 ----------

test('真实 queue.json 条目端到端生成非空 BibTeX / RIS', () => {
  const queuePath = path.join(ROOT, 'queue.json');
  assert.ok(fs.existsSync(queuePath), `未找到 queue.json：${queuePath}`);
  const queue: QueueEntry[] = decodeQueue(JSON.parse(fs.readFileSync(queuePath, 'utf8')));
  assert.ok(queue.length > 0, '队列不应为空');

  const out = bibtexAll(queue);
  assert.ok(out.length > 0, 'BibTeX 输出不应为空');
  assert.ok(out.includes('@'), 'BibTeX 输出必须含 @');
  assert.ok(out.includes('@article{') || out.includes('@misc{'), out.slice(0, 200));

  const r = risAll(queue);
  assert.ok(r.length > 0, 'RIS 输出不应为空');
  assert.ok(r.includes('TY  - '), r.slice(0, 120));
  assert.ok(r.includes('ER  - '), '每条 RIS 都应以 ER 收尾');

  const first = queue[0];
  const one = bibtex(first);
  assert.ok(one.startsWith('@article{') || one.startsWith('@misc{'), one);
  assert.ok(!/^\s*[A-Za-z]+ = \{\},?$/m.test(one), '真实数据也不得产生空字段：' + one);
});
