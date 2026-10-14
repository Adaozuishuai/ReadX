// LaTeX 排版引擎回归（移植自 macOS MathTypeset / MathText）。
//
// 最关键的硬约束：**遇到不认识的命令必须整式降级**，绝不能半渲染半猜测——
// 把错的公式渲染得像对的，比不渲染更危险。其余是分段、Unicode 扁平化、
// 宽度估算与 HTML 结构。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMath, isUnsupported, flattenNode, flattenUnicode,
  nodeWidth, nodesWidth, nodeHeight,
  segmentMath, blockMathLine, mathNodeHTML, mathBlockHTML, mathInlineHTML, renderRichHTML,
  MATH_SYMBOLS, UPRIGHT_FUNCTIONS, BIG_OPS, MathNode,
} from '../core/mathTypeset';

// ---------- 解析 ----------

test('基本符号：希腊字母、运算符、函数名', () => {
  const r = parseMath('\\alpha + \\beta \\times \\log x');
  assert.equal(r.supported, true);
  assert.equal(flattenNode({ kind: 'group', items: r.nodes }), 'α + β × log x');
});

test('上下标：x_i^2 解析为 script，扁平化为 Unicode', () => {
  const r = parseMath('x_i^2');
  assert.equal(r.supported, true);
  assert.equal(flattenUnicode(r.nodes), 'xᵢ²');
});

test('分数与根号：可解析但不可扁平化（交给结构渲染）', () => {
  const frac = parseMath('\\frac{a}{b}');
  assert.equal(frac.supported, true);
  assert.equal(flattenUnicode(frac.nodes), null);
  const root = parseMath('\\sqrt{x}');
  assert.equal(root.supported, true);
  assert.equal(flattenUnicode(root.nodes), null);
});

test('\\sqrt[n]{x} 带次数', () => {
  const r = parseMath('\\sqrt[3]{x}');
  assert.equal(r.supported, true);
  const root = r.nodes[0];
  assert.equal(root.kind, 'root');
  if (root.kind === 'root') assert.ok(root.index, '应有次数');
});

test('大算子带上限：\\sum_{i=1}^{n}', () => {
  const r = parseMath('\\sum_{i=1}^{n} x_i');
  assert.equal(r.supported, true);
  const op = r.nodes[0];
  assert.equal(op.kind, 'bigOp');
  if (op.kind === 'bigOp') { assert.equal(op.op, '∑'); assert.ok(op.sub); assert.ok(op.sup); }
});

test('定界符 \\left( \\right) 不引入 unsupported', () => {
  const r = parseMath('\\left( \\frac{a}{b} \\right)');
  assert.equal(r.supported, true);
});

test('**未知命令必须整式降级**（核心硬约束）', () => {
  const r = parseMath('\\begin{matrix} a & b \\end{matrix}');
  assert.equal(r.supported, false);
  assert.ok(r.nodes.some(isUnsupported));
  // 即使式子里有可识别片段，也必须整体降级
  const mixed = parseMath('x + \\foobar + y');
  assert.equal(mixed.supported, false);
  const html = mathBlockHTML('x + \\foobar + y');
  assert.equal(html.supported, false);
  assert.ok(html.html.includes('m-fallback'), '必须走整式回退');
  assert.ok(!html.html.includes('m-math'), '回退时不得输出半渲染的数学结构');
});

test('未知命令嵌在字体/文本命令里也必须整式降级（不得 flatten 成原始源码）', () => {
  // 这些命令走纯文本参数路径；曾经的缺陷是把 flatten 出的原始源码当成已排版内容，
  // 于是 supported=true、公式半渲染得「像对的」。
  for (const src of ['\\mathbb{\\foo}', '\\mathcal{\\qqq}', '\\mathrm{\\unknowncmd}', '\\text{\\badcmd}', '\\mathit{\\zzz}']) {
    const r = mathBlockHTML(src);
    assert.equal(r.supported, false, src + ' 应整式降级');
    assert.ok(r.html.includes('m-fallback'), src);
    assert.ok(!r.html.includes('m-math'), src + ' 不得半渲染');
  }
  // 正常字体命令仍应可用
  assert.equal(parseMath('\\mathbb{R}').supported, true);
  assert.equal(parseMath('\\text{PSNR}').supported, true);
});

test('未知命令的降级不吞掉可识别部分之外的正文', () => {
  const html = mathBlockHTML('E = mc^2 \\weirdcmd');
  assert.ok(html.html.includes('m-fallback'));
  assert.ok(html.html.includes('weirdcmd'.slice(0, 5)), '源码应保留在回退里');
});

test('多余右括号被忽略且不崩', () => {
  const r = parseMath('a } b');
  assert.equal(r.supported, true);
  // 多余的 } 被跳过，其余字符保留
  assert.equal(flattenNode({ kind: 'group', items: r.nodes }), 'a  b');
});

test('孤立上标不崩（无底数）', () => {
  const r = parseMath('^2');
  assert.equal(r.supported, true);
  assert.equal(r.nodes[0].kind, 'script');
});

test('\\text / \\mathrm / 函数名走正体', () => {
  const r = parseMath('\\text{PSNR} + \\mathrm{dB} + \\sin');
  assert.equal(r.supported, true);
  const html = mathNodeHTML({ kind: 'group', items: r.nodes });
  assert.ok(html.includes('m-r'), '应含正体节点');
});

test('\\mathbb{R} 与 \\mathcal{L} 映射到 Unicode', () => {
  assert.equal(flattenNode({ kind: 'group', items: parseMath('\\mathbb{R}').nodes }), 'ℝ');
  const cal = flattenNode({ kind: 'group', items: parseMath('\\mathcal{L}').nodes });
  assert.notEqual(cal, 'L', '花体应替换为 Unicode 花体字符');
});

// ---------- 宽度 / 高度估算 ----------

test('宽度估算：纯函数、随字号线性、分数比单字符宽', () => {
  const nodes = parseMath('abc').nodes;
  const w10 = nodesWidth(nodes, 10);
  const w20 = nodesWidth(nodes, 20);
  assert.ok(Math.abs(w20 - w10 * 2) < 1e-6, '宽度随字号线性');
  const fracW = nodeWidth(parseMath('\\frac{a}{b}').nodes[0], 16);
  const chW = nodeWidth({ kind: 'text', value: 'a' }, 16);
  assert.ok(fracW > chW, '分数应比单个字符宽');
});

test('高度估算：分数/大算子高于普通字符', () => {
  const plainH = nodeHeight({ kind: 'text', value: 'x' }, 16);
  const fracH = nodeHeight(parseMath('\\frac{a}{b}').nodes[0], 16);
  const sumH = nodeHeight(parseMath('\\sum_{i}^{n}').nodes[0], 16);
  assert.ok(fracH > plainH);
  assert.ok(sumH > plainH);
});

// ---------- 分段 ----------

test('分段：行内 $…$、独立 $$…$$、\\(...\\)、\\[…\\]', () => {
  assert.deepEqual(segmentMath('a $x^2$ b').map((s) => s.kind), ['text', 'inlineMath', 'text']);
  assert.deepEqual(segmentMath('$$x$$').map((s) => s.kind), ['blockMath']);
  assert.deepEqual(segmentMath('a \\(y\\) b').map((s) => s.kind), ['text', 'inlineMath', 'text']);
  assert.deepEqual(segmentMath('\\[z\\]').map((s) => s.kind), ['blockMath']);
});

test('分段：未闭合定界符按普通文本处理，不吞正文', () => {
  const segs = segmentMath('unclosed $x and more text');
  assert.deepEqual(segs.map((s) => s.kind), ['text']);
  assert.ok(segs[0].kind === 'text' && segs[0].value.includes('and more text'));
});

test('分段：$ 后紧跟空白不算公式（避免误判货币）', () => {
  const segs = segmentMath('price is $ 5 dollars');
  assert.deepEqual(segs.map((s) => s.kind), ['text']);
});

test('分段：行内公式不跨行', () => {
  const segs = segmentMath('$a\nb$');
  assert.deepEqual(segs.map((s) => s.kind), ['text'], '跨行 $…$ 不成立');
});

test('blockMathLine 识别整行独立公式', () => {
  assert.equal(blockMathLine('$$x^2$$'), 'x^2');
  assert.equal(blockMathLine('\\[y\\]'), 'y');
  assert.equal(blockMathLine('$x$'), null, '单个 $ 不算独立块');
  assert.equal(blockMathLine('普通文本'), null);
});

// ---------- HTML 渲染 ----------

test('HTML：上下标/分数/根号结构输出对应 class', () => {
  assert.ok(mathNodeHTML(parseMath('x_i').nodes[0]).includes('m-scripts'));
  assert.ok(mathNodeHTML(parseMath('\\frac{a}{b}').nodes[0]).includes('m-frac'));
  assert.ok(mathNodeHTML(parseMath('\\sqrt{x}').nodes[0]).includes('m-root'));
  assert.ok(mathNodeHTML(parseMath('\\sum_{i}^{n}').nodes[0]).includes('m-bigop'));
});

test('HTML 转义：不产生可注入标签', () => {
  const html = mathNodeHTML({ kind: 'text', value: '<img onerror=x>' });
  assert.ok(!html.includes('<img'), '必须转义');
  assert.ok(html.includes('&lt;img'));
});

test('行内：简单公式用 Unicode 扁平化，不进结构渲染', () => {
  const r = mathInlineHTML('x_i^2');
  assert.equal(r.supported, true);
  assert.ok(r.html.includes('m-flat'), '应走扁平化');
  assert.ok(r.html.includes('xᵢ²'));
});

test('行内：复杂公式走结构渲染而不是扁平化', () => {
  const r = mathInlineHTML('\\frac{a}{b}');
  assert.equal(r.supported, true);
  assert.ok(r.html.includes('m-inline'));
  assert.ok(r.html.includes('m-frac'));
});

test('renderRichHTML：正文 + 行内公式混排', () => {
  const html = renderRichHTML('损失 $L_2$ 用于训练', (s) => `<em>${s}</em>`);
  assert.ok(html.includes('<em>损失 </em>'));
  assert.ok(html.includes('L₂'));
  assert.ok(html.includes('<em> 用于训练</em>'));
});

// ---------- 词表完整性（防止移植时漏项）----------

test('词表非空且关键条目齐全', () => {
  assert.ok(Object.keys(MATH_SYMBOLS).length > 100);
  assert.equal(MATH_SYMBOLS.alpha, 'α');
  assert.equal(MATH_SYMBOLS.sum, '∑');
  assert.equal(MATH_SYMBOLS.leq, '≤');
  assert.ok(UPRIGHT_FUNCTIONS.has('log'));
  assert.ok(UPRIGHT_FUNCTIONS.has('sin'));
  assert.ok(BIG_OPS.has('int'));
});

test('真实公式样本：NAF 论文风格的公式可排版或整体降级，不会半渲染', () => {
  const samples = [
    'I = I_0 \\exp\\left(-\\sum_i \\mu_i \\delta_i\\right)',
    '\\mu_\\theta: \\mathbb{R}^3 \\to \\mathbb{R}',
    '\\mathcal{L} = \\sum_{r} \\left\\| I_r - \\hat{I}_r \\right\\|_2^2',
  ];
  for (const s of samples) {
    const html = mathBlockHTML(s);
    if (html.supported) assert.ok(html.html.includes('m-math'), s);
    else assert.ok(html.html.includes('m-fallback'), s);
    // 无论走哪条路，都不能同时出现结构渲染与回退
    assert.ok(!(html.html.includes('m-math') && html.html.includes('m-fallback')), s);
  }
});
