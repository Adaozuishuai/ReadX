// 自动导入（下载 PDF + 抽取全文）的回归。
//
// 重点锁住「不猜、不崩、不冒充」这三条：
//  - 非 PDF 响应（登录页/HTML）必须被魔数校验挡住；
//  - 扫描件抽不出文字时必须如实报告，而不是写空缓存冒充「有全文」；
//  - 按 y 坐标归并行，保证表格/表头不糊成一整段。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikePdf, groupItemsIntoLines, formatPdfPages, isLikelyScanned } from '../core/pdfText';
import { resolvePdfUrl } from '../main/fetchPaper';

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

test('魔数校验：真 PDF 通过，HTML/空内容被拒', () => {
  assert.equal(looksLikePdf(PDF_MAGIC), true);
  const html = new TextEncoder().encode('<html><body>login</body></html>');
  assert.equal(looksLikePdf(html), false);
  assert.equal(looksLikePdf(new Uint8Array([])), false);
  assert.equal(looksLikePdf(new Uint8Array([0x25, 0x50])), false, '不足 5 字节无效');
});

test('行归并：同一行的碎片按 x 排序拼接，不同 y 分成不同行', () => {
  // 模拟一行表头 "Dataset PSNR" 与一行数据 "Aorta 32.5"
  const items = [
    { str: 'PSNR', x: 100, y: 700 },
    { str: 'Dataset', x: 20, y: 700 },   // 同一行、x 更小，应排在前面
    { str: 'Aorta', x: 20, y: 680 },
    { str: '32.5', x: 100, y: 680 },
  ];
  const lines = groupItemsIntoLines(items);
  assert.deepEqual(lines, ['Dataset PSNR', 'Aorta 32.5']);
});

test('行归并：y 容差内的轻微抖动视为同一行', () => {
  const items = [
    { str: 'A', x: 10, y: 700.0 },
    { str: 'B', x: 30, y: 701.5 }, // 1.5 < 3 容差
  ];
  assert.deepEqual(groupItemsIntoLines(items), ['A B']);
});

test('行归并：空项被忽略，全空返回空数组', () => {
  assert.deepEqual(groupItemsIntoLines([]), []);
  assert.deepEqual(groupItemsIntoLines([{ str: '', x: 1, y: 1 }, { str: '   ', x: 2, y: 1 }]), []);
});

test('分页格式与 evidence.pages() 的标记一致', () => {
  const text = formatPdfPages([
    { number: 1, lines: ['hello', 'world'] },
    { number: 2, lines: ['second page'] },
  ]);
  assert.ok(text.includes('=== Page 1 ==='));
  assert.ok(text.includes('=== Page 2 ==='));
  assert.equal((text.match(/=== Page /g) ?? []).length, 2);
});

test('扫描件判定：可读字符过少视为扫描件，正常文本不算', () => {
  assert.equal(isLikelyScanned('=== Page 1 ===\n\n\n.'), true);
  const normal = '=== Page 1 ===\n' + 'We reconstruct sparse-view CBCT volumes using a neural attenuation field. '.repeat(3);
  assert.equal(isLikelyScanned(normal), false);
});

test('PDF 地址解析：优先条目自带 pdfUrl', () => {
  assert.equal(resolvePdfUrl('2209.14540', 'https://example.com/a.pdf'), 'https://example.com/a.pdf');
});

test('PDF 地址解析：arXiv key 用规范地址（笔记条目没有 pdfUrl 时）', () => {
  assert.equal(resolvePdfUrl('2209.14540', null), 'https://arxiv.org/pdf/2209.14540');
  assert.equal(resolvePdfUrl('2401.00135', undefined), 'https://arxiv.org/pdf/2401.00135');
});

test('PDF 地址解析：非 arXiv 且无 pdfUrl 时保持 null（不猜）', () => {
  assert.equal(resolvePdfUrl('intratomo-2021', null), null);
  assert.equal(resolvePdfUrl('pubmed-12345', ''), null);
  // 形似但不是 arXiv 号的 key 不应被当成 arXiv
  assert.equal(resolvePdfUrl('2022-naf', null), null);
});
