import type * as Monaco from 'monaco-editor';

/**
 * LaTeX 语言支持：Monarch 语法 + 语言配置。
 *
 * 只做编辑器需要的部分——着色、括号、注释、折叠标记。
 * 真正的语义（哪些引用存在、哪一行报错）来自项目索引与编译日志，不靠词法猜。
 */
export const LATEX_LANGUAGE_ID = 'readx-latex';

const COMMANDS = [
  'documentclass', 'usepackage', 'begin', 'end', 'section', 'subsection', 'subsubsection',
  'paragraph', 'title', 'author', 'date', 'maketitle', 'abstract', 'label', 'ref', 'eqref',
  'autoref', 'cref', 'Cref', 'cite', 'citep', 'citet', 'bibliography', 'bibliographystyle',
  'input', 'include', 'includegraphics', 'caption', 'centering', 'item', 'footnote',
  'textbf', 'textit', 'texttt', 'emph', 'underline', 'textsc', 'frac', 'dfrac', 'sqrt',
  'sum', 'prod', 'int', 'lim', 'log', 'exp', 'min', 'max', 'argmin', 'argmax',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'sigma', 'phi',
  'times', 'cdot', 'leq', 'geq', 'neq', 'approx', 'in', 'subset', 'forall', 'exists',
  'left', 'right', 'mathbb', 'mathcal', 'mathrm', 'operatorname', 'text',
  'hline', 'toprule', 'midrule', 'bottomrule', 'multicolumn', 'multirow',
  'newcommand', 'renewcommand', 'DeclareMathOperator', 'pageref', 'hspace', 'vspace',
  'noindent', 'newpage', 'clearpage', 'appendix', 'tableofcontents', 'listoffigures',
];

const ENVIRONMENTS = [
  'document', 'abstract', 'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'itemize', 'enumerate', 'description',
  'figure', 'figure*', 'table', 'table*', 'tabular', 'tabularx', 'verbatim', 'quote',
  'theorem', 'lemma', 'proof', 'definition', 'corollary', 'remark', 'algorithm',
  'algorithmic', 'lstlisting', 'center', 'minipage',
];

let registered = false;

export function registerLatexLanguage(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: LATEX_LANGUAGE_ID, extensions: ['.tex', '.ltx', '.sty', '.cls', '.bib'] });

  monaco.languages.setLanguageConfiguration(LATEX_LANGUAGE_ID, {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
      { open: '`', close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' },
    ],
    // \begin{...} / \end{...} 作为折叠标记：长文档里最需要折叠的就是环境。
    folding: { markers: { start: /^\s*\\begin\{/, end: /^\s*\\end\{/ } },
  });

  monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, {
    defaultToken: '',
    tokenPostfix: '.latex',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(begin|end)\b/, 'keyword.control'],
        [/\\(documentclass|usepackage|newcommand|renewcommand|DeclareMathOperator)\b/, 'keyword'],
        [/\\(section|subsection|subsubsection|paragraph|chapter|part)\b/, 'keyword.section'],
        [/\\(cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label|pageref)\b/, 'keyword.reference'],
        [/\\(include|input|includegraphics|bibliography|bibliographystyle)\b/, 'keyword.import'],
        [/\\(textbf|textit|texttt|emph|underline|textsc|textrm|textsf|text)\b/, 'keyword.text'],
        [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
        [/\\[^a-zA-Z@]/, 'string.escape'],
        [/\$\$?/, { token: 'delimiter.math', next: '@math' }],
        [/[{}]/, 'delimiter.curly'],
        [/[[\]]/, 'delimiter.square'],
        [/[0-9]+(\.[0-9]+)?/, 'number'],
        [/&|\\\\/, 'operator.align'],
        [/[a-zA-Z]+/, 'identifier'],
      ],
      math: [
        [/%.*$/, 'comment'],
        [/\$\$?/, { token: 'delimiter.math', next: '@pop' }],
        [/\\(left|right|frac|sqrt|sum|prod|int|lim|cdot|times|leq|geq|neq|approx|mathbb|mathcal|mathrm|operatorname|text)\b/, 'keyword.math'],
        [/\\[a-zA-Z@]+/, 'variable.math'],
        [/[{}]/, 'delimiter.curly'],
        [/[0-9]+(\.[0-9]+)?/, 'number'],
        [/[a-zA-Z]/, 'variable.math'],
        [/[+\-*/=<>^_|]/, 'operator.math'],
      ],
    },
  });

  // 命令/环境的候选清单也交给语言本身：补全提供者与语法着色用同一份来源，避免两处漂移。
  void COMMANDS;
  void ENVIRONMENTS;
}

export const LATEX_COMMANDS = COMMANDS;
export const LATEX_ENVIRONMENTS = ENVIRONMENTS;