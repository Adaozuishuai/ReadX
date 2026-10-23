import type * as Monaco from 'monaco-editor';
import { latexCompletionContext } from '@cbct/shared';
import { LATEX_COMMANDS, LATEX_ENVIRONMENTS, LATEX_LANGUAGE_ID } from './latexLanguage';

export interface LatexCompletionIndex {
  citations: string[];
  labels: string[];
}

const COMMON_PACKAGES = [
  'geometry', 'amsmath', 'amssymb', 'graphicx', 'hyperref', 'booktabs', 'multirow',
  'algorithm', 'algorithmic', 'listings', 'xcolor', 'subcaption', 'caption', 'natbib',
  'biblatex', 'siunitx', 'cleveref', 'bm', 'mathtools', 'fontspec', 'ctex', 'xeCJK',
];

/** 带参数的常用命令：插入时把参数位置留成占位符，省得用户再补括号。 */
const COMMAND_ARGUMENTS: Record<string, string> = {
  documentclass: 'documentclass[11pt]{article}',
  usepackage: 'usepackage{$1}',
  section: 'section{$1}',
  subsection: 'subsection{$1}',
  subsubsection: 'subsubsection{$1}',
  label: 'label{$1}',
  ref: 'ref{$1}',
  eqref: 'eqref{$1}',
  cite: 'cite{$1}',
  citep: 'citep{$1}',
  citet: 'citet{$1}',
  includegraphics: 'includegraphics[width=0.8\\linewidth]{figures/$1}',
  caption: 'caption{$1}',
  footnote: 'footnote{$1}',
  textbf: 'textbf{$1}',
  textit: 'textit{$1}',
  emph: 'emph{$1}',
  frac: 'frac{$1}{$2}',
  sqrt: 'sqrt{$1}',
  input: 'input{$1}',
  include: 'include{$1}',
  hspace: 'hspace{$1}',
  vspace: 'vspace{$1}',
  bibliography: 'bibliography{$1}',
  bibliographystyle: 'bibliographystyle{$1}',
};

/**
 * 补全提供者。
 *
 * 四种上下文各给各的候选，不做「全都塞进一个列表」：在 `\cite{` 里出现命令补全
 * 只会让人误选。上下文由光标前的文本判断；键名来自服务端项目索引
 * （.bib 的条目、.tex 的 \label），不是前端猜的。
 *
 * 索引通过 getter 读取当前项目，提供者随编辑器一起注册和释放。
 */
export function registerLatexCompletion(monaco: typeof Monaco, getIndex: () => LatexCompletionIndex) {
  const kinds = monaco.languages.CompletionItemKind;
  const rules = monaco.languages.CompletionItemInsertTextRule;

  return monaco.languages.registerCompletionItemProvider(LATEX_LANGUAGE_ID, {
    triggerCharacters: ['\\', '{', ','],

    provideCompletionItems(model, position) {
      const line = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const context = latexCompletionContext(line);
      if (context === 'cite') {
        return {
          suggestions: getIndex().citations.map((key) => ({
            label: key,
            kind: kinds.Reference,
            detail: '参考文献键（来自 .bib）',
            insertText: key,
            range,
          })),
        };
      }
      if (context === 'ref') {
        return {
          suggestions: getIndex().labels.map((key) => ({
            label: key,
            kind: kinds.Reference,
            detail: '标签（来自 \\label）',
            insertText: key,
            range,
          })),
        };
      }
      if (context === 'begin') {
        // 补 \begin 的同时把 \end 一起写好：只补一半等于把配对工作留给用户。
        return {
          suggestions: LATEX_ENVIRONMENTS.map((environment) => ({
            label: environment,
            kind: kinds.Snippet,
            detail: '环境（含配对的 \\end）',
            insertText: `begin{${environment}}\n\t$0\n\\end{${environment}}`,
            insertTextRules: rules.InsertAsSnippet,
            range,
          })),
        };
      }
      if (context === 'usepackage') {
        return {
          suggestions: COMMON_PACKAGES.map((name) => ({
            label: name,
            kind: kinds.Module,
            detail: '宏包',
            insertText: name,
            range,
          })),
        };
      }
      if (context === 'command') {
        return {
          suggestions: LATEX_COMMANDS.map((command) => ({
            label: `\\${command}`,
            kind: kinds.Snippet,
            detail: '命令',
            insertText: COMMAND_ARGUMENTS[command] ?? `${command}{$1}`,
            insertTextRules: rules.InsertAsSnippet,
            range,
          })),
        };
      }
      // 其它位置不打扰：只在用户开始敲命令时提示。
      return { suggestions: [] };
    },
  });
}

/**
 * 把「引用了不存在的键」标成编辑器里的波浪线。
 *
 * 这是编译**必然**会报 undefined 的硬问题，能在写的时候就看见，比等编译失败强；
 * 判断依据是服务端索引，不是前端猜的。注释行不提示——那只是草稿。
 */
export function applyIndexMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  index: LatexCompletionIndex & { missingCitations?: string[]; missingLabels?: string[] },
) {
  const missingCitations = new Set(index.missingCitations ?? []);
  const missingLabels = new Set(index.missingLabels ?? []);
  const markers: Monaco.editor.IMarkerData[] = [];
  const lines = model.getValue().split('\n');

  const scan = (pattern: RegExp, missing: Set<string>, message: (key: string) => string) => {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const raw = lines[lineIndex] ?? '';
      const comment = raw.indexOf('%');
      const body = comment >= 0 ? raw.slice(0, comment) : raw;
      pattern.lastIndex = 0;
      let match = pattern.exec(body);
      while (match) {
        const group = match[1] ?? '';
        for (const candidate of group.split(',')) {
          const key = candidate.trim();
          if (!key || !missing.has(key) || !group.includes(candidate)) continue;
          const start = match.index + (match[0]?.indexOf(group) ?? 0) + group.indexOf(candidate);
          markers.push({
            severity: monaco.MarkerSeverity.Warning,
            message: message(key),
            startLineNumber: lineIndex + 1,
            startColumn: start + 1,
            endLineNumber: lineIndex + 1,
            endColumn: start + candidate.length + 1,
          });
        }
        match = pattern.exec(body);
      }
    }
  };

  scan(/\\cite[a-zA-Z]*\s*(?:\[[^\]]*\])*\s*\{([^}]+)\}/g, missingCitations,
    (key) => `引用了不存在的参考文献键「${key}」：.bib 里没有这个条目，编译会报 undefined citation。`);
  scan(/\\(?:ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g, missingLabels,
    (key) => `引用了不存在的标签「${key}」：没有对应的 \\label，编译会报 undefined reference。`);

  monaco.editor.setModelMarkers(model, 'readx-latex-index', markers);
  return markers.length;
}
