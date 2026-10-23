import test from 'node:test';
import assert from 'node:assert/strict';

import { latexCompletionContext } from './latex.js';

// 这些用例来自真实踩过的坑：上下文判断写错时，界面上的表现只是
// 「补全列表里混进了文档里的词」，看界面完全定位不到原因。
test('键名上下文：\\cite 与 \\ref 的括号未闭合时只给键名', () => {
  assert.equal(latexCompletionContext('\\cite{'), 'cite');
  assert.equal(latexCompletionContext('\\citep{lovelace'), 'cite');
  assert.equal(latexCompletionContext('\\cite[see][p.3]{zhang'), 'cite');
  assert.equal(latexCompletionContext('正文里引用 \\cite{a,b'), 'cite');
  assert.equal(latexCompletionContext('\\ref{sec:method'), 'ref');
  assert.equal(latexCompletionContext('\\eqref{eq:1'), 'ref');
  assert.equal(latexCompletionContext('\\cref{fig:1'), 'ref');
});

test('括号闭合之后不再是键名上下文', () => {
  // 光标已经跑到 } 之后：这时给键名候选没有意义，也不该误判成命令上下文。
  assert.equal(latexCompletionContext('\\cite{lovelace2026}'), 'none');
  assert.equal(latexCompletionContext('\\ref{sec:method} 见'), 'none');
});

test('命令上下文：反斜杠后正在敲命令名', () => {
  assert.equal(latexCompletionContext('\\'), 'command');
  assert.equal(latexCompletionContext('\\sect'), 'command');
  assert.equal(latexCompletionContext('文字 \\includegraphics'), 'command');
});

test('环境与宏包各有各的上下文', () => {
  assert.equal(latexCompletionContext('\\begin{'), 'begin');
  assert.equal(latexCompletionContext('\\begin{equ'), 'begin');
  assert.equal(latexCompletionContext('\\usepackage{'), 'usepackage');
  assert.equal(latexCompletionContext('\\usepackage[utf8]{'), 'usepackage');
  // \begin{...} 写完之后不该再提示环境。
  assert.equal(latexCompletionContext('\\begin{document}'), 'none');
});

test('普通文本里不打扰用户', () => {
  assert.equal(latexCompletionContext(''), 'none');
  assert.equal(latexCompletionContext('这是一段普通的中文'), 'none');
  assert.equal(latexCompletionContext('The quick brown fox'), 'none');
  assert.equal(latexCompletionContext('  '), 'none');
});

test('注释行按文本处理，不当成命令上下文', () => {
  // 注释里写 \cite{ 也该给键名：作者常常先在注释里起草引用。
  assert.equal(latexCompletionContext('% 待补：\\cite{'), 'cite');
  assert.equal(latexCompletionContext('% 先记一下 \\'), 'command');
});