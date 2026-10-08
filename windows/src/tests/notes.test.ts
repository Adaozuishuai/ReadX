// 笔记解析回归。两个真实缺陷：
// 1) 标题带编号（`## 1. 问题设定`）时，除第一段外全部段落被静默丢弃；
// 2) 去编号正则把可选分隔符写成可选，`一句话总结` 被吃掉「一」变成「句话总结」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { loadNotes, parseFrontmatter, splitSections, noteKey, noteTitle, noteForQueue } from '../core/notes';
import { findRoot, Paths } from '../core/store';
import { arxivKey } from '../core/paper';

const ROOT = findRoot(__dirname);
const paths = new Paths(ROOT);

test('frontmatter 解析 key: value 与列表', () => {
  const { meta, body } = parseFrontmatter('---\narxiv: "2209.14540"\ntitle: NAF\n---\n正文');
  assert.equal(meta.arxiv, '2209.14540');
  assert.equal(meta.title, 'NAF');
  assert.equal(body, '正文');
});

test('未闭合 frontmatter 不崩，按正文处理', () => {
  const src = '---\narxiv: x\n没有闭合';
  const { meta, body } = parseFrontmatter(src);
  assert.deepEqual(meta, {});
  assert.equal(body, src);
});

test('带编号的标题必须能识别（否则段落被静默丢弃）', () => {
  const body = [
    '## 一句话总结', '总结内容',
    '## 1. 问题设定', '设定内容',
    '## 2. 方法核心', '方法内容',
    '## 3. 实验可信度', '实验内容',
    '## 4. 研究启发', '启发内容',
    '## 5. 我的批注', '批注内容',
  ].join('\n');
  const s = splitSections(body);
  assert.equal(s.summary, '总结内容');
  assert.equal(s.setup, '设定内容');
  assert.equal(s.method, '方法内容');
  assert.equal(s.experiments, '实验内容');
  assert.equal(s.insights, '启发内容');
  assert.equal(s.annotations, '批注内容');
});

test('中文数字开头的标题不得被吃掉首字（一句话总结 != 句话总结）', () => {
  const s = splitSections('## 一句话总结\nX');
  assert.equal(s.summary, 'X', '「一」是标题的一部分，不是编号分隔符');
  // 真正的中文编号仍需剥离
  const t = splitSections('## 一、问题设定\nY');
  assert.equal(t.setup, 'Y');
});

test('阿拉伯数字开头的正常标题不被误剥（3D 方法）', () => {
  // "3D 重建" 不是编号：没有分隔符
  const s = splitSections('## 一句话总结\nA\n## 3D 重建方法\nB');
  assert.equal(s.summary, 'A');
  // 该标题不匹配任何已知段落，不应污染其它段落
  assert.ok(!Object.values(s).some((v) => v.includes('B')), '未知标题内容不得并入已知段落');
});

test('真实笔记：全部 6 个段落都能解析出来', () => {
  const r = loadNotes(paths.papersDir);
  if (!r.notes.length) return; // 无笔记则跳过
  const naf = r.notes.find((n) => arxivKey(n.meta.arxiv ?? '') === '2209.14540');
  if (!naf) return;
  assert.equal(noteKey(naf), '2209.14540');
  for (const k of ['summary', 'setup', 'method', 'experiments', 'insights', 'annotations']) {
    assert.ok((naf.sections[k] ?? '').length > 0, `真实笔记缺少段落：${k}`);
  }
});

test('真实笔记的 title/venue 来自 frontmatter', () => {
  const r = loadNotes(paths.papersDir);
  const naf = r.notes.find((n) => noteKey(n) === '2209.14540');
  if (!naf) return;
  assert.ok(noteTitle(naf).includes('NAF'));
  assert.ok(naf.meta.venue.includes('MICCAI'));
});

test('_template.md 被跳过，不是笔记', () => {
  const r = loadNotes(paths.papersDir);
  assert.ok(!r.notes.some((n) => n.file.startsWith('_')));
});

test('队列条目能匹配到笔记（arxiv / id / 标题兜底）', () => {
  const r = loadNotes(paths.papersDir);
  if (!r.notes.length) return;
  const byArxiv = noteForQueue(r.notes, { arxiv: '2209.14540' });
  assert.ok(byArxiv, '应能按 arxiv 匹配');
  const byId = noteForQueue(r.notes, { id: '2022-naf' });
  assert.ok(byId, '应能按文件名 id 匹配');
  const none = noteForQueue(r.notes, { arxiv: '9999.99999', title: '完全无关的论文标题' });
  assert.equal(none, null);
});

test('损坏的笔记文件被显式报告，不静默跳过', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'windows', '.tmp-notes-'));
  fs.writeFileSync(path.join(dir, 'empty.md'), '   ');
  const r = loadNotes(dir);
  assert.equal(r.notes.length, 0);
  assert.ok(r.failed.length === 1, '空笔记必须出现在 failed 里');
  fs.rmSync(dir, { recursive: true, force: true });
});
