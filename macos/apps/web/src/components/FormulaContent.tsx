import type { ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

function renderMath(tex: string, displayMode: boolean) {
  return katex.renderToString(tex.trim(), {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
    output: 'htmlAndMathml',
  });
}

export function LatexFormula({ latex }: { latex: string }) {
  return <div className="reading-formula" aria-label="LaTeX 公式">
    <div className="reading-formula-render" dangerouslySetInnerHTML={{ __html: renderMath(latex, true) }} />
    <details><summary>查看 LaTeX 源码</summary><code>{latex}</code></details>
  </div>;
}

export function MathText({ text }: { text: string }) {
  const source = text;
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$[^$\n]+\$)/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) parts.push(source.slice(last, match.index));
    const value = match[0];
    const display = value.startsWith('$$') || value.startsWith('\\[');
    const tex = display ? value.slice(2, -2) : value.startsWith('\\(') ? value.slice(2, -2) : value.slice(1, -1);
    parts.push(<span key={`${match.index}-${value}`} className={display ? 'reading-math-display' : 'reading-math-inline'} dangerouslySetInnerHTML={{ __html: renderMath(tex, display) }} />);
    last = match.index + value.length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return <>{parts}</>;
}
