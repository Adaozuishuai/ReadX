// 轻量 LaTeX 排版引擎（离线、无依赖）——移植自 macOS MathTypeset.swift / MathText.swift。
//
// 设计原则（与项目「不猜、可核对」一致）：
// - 只排版能确定的结构；遇到不认识的命令立即标记 unsupported，**整式**降级为原始 LaTeX 展示，
//   绝不半渲染半猜测，避免把错的公式渲染得像对的；
// - 行内公式与独立公式块共用同一棵节点树，只是容器与缩放策略不同；
// - 宽度用纯函数估算（不依赖浏览器布局测量），据此决定缩放或横向滚动，保证不溢出容器。
//
// 输出是 HTML 字符串（Windows 渲染层是 DOM），但解析器与度量是纯逻辑，可单独回归测试。

export type MathNode =
  | { kind: 'text'; value: string }
  | { kind: 'upright'; value: string }
  | { kind: 'symbol'; value: string }
  | { kind: 'bigOp'; op: string; sub: MathNode | null; sup: MathNode | null }
  | { kind: 'script'; base: MathNode; sub: MathNode | null; sup: MathNode | null }
  | { kind: 'frac'; a: MathNode; b: MathNode }
  | { kind: 'root'; a: MathNode; index: MathNode | null }
  | { kind: 'overline'; a: MathNode }
  | { kind: 'group'; items: MathNode[] }
  | { kind: 'accent'; a: MathNode; accent: string }
  | { kind: 'bold'; a: MathNode }
  | { kind: 'blackboard'; a: MathNode }
  | { kind: 'calligraphic'; value: string }
  | { kind: 'unsupported'; raw: string };

/** 递归判断是否含无法排版的节点；含则整式必须降级。 */
export function isUnsupported(node: MathNode): boolean {
  switch (node.kind) {
    case 'unsupported': return true;
    case 'text': case 'upright': case 'symbol': case 'calligraphic': return false;
    case 'bigOp': return isUnsupported(node.sub ?? EMPTY) || isUnsupported(node.sup ?? EMPTY);
    case 'script': return isUnsupported(node.base) || isUnsupported(node.sub ?? EMPTY) || isUnsupported(node.sup ?? EMPTY);
    case 'frac': return isUnsupported(node.a) || isUnsupported(node.b);
    case 'root': return isUnsupported(node.a) || isUnsupported(node.index ?? EMPTY);
    case 'overline': return isUnsupported(node.a);
    case 'group': return node.items.some(isUnsupported);
    case 'accent': return isUnsupported(node.a);
    case 'bold': case 'blackboard': return isUnsupported(node.a);
  }
}
const EMPTY: MathNode = { kind: 'text', value: '' };

// MARK: - 词法表

export const MATH_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  ell: 'ℓ', hbar: 'ℏ', imath: 'ı', jmath: 'ȷ',
  times: '×', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  div: '÷', pm: '±', mp: '∓', oplus: '⊕', ominus: '⊖', otimes: '⊗',
  oslash: '⊘', odot: '⊙', dagger: '†', ddagger: '‡',
  leq: '≤', geq: '≥', le: '≤', ge: '≥', neq: '≠', ne: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅',
  rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', to: '→',
  uparrow: '↑', downarrow: '↓',
  nabla: '∇', partial: '∂', infty: '∞', forall: '∀', exists: '∃',
  neg: '¬', land: '∧', lor: '∨', perp: '⊥', top: '⊤', angle: '∠', prime: '′',
  dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  deg: '°', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  langle: '⟨', rangle: '⟩', Vert: '‖', vert: '∣', '|': '‖',
  lVert: '‖', rVert: '‖', lvert: '∣', rvert: '∣',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigodot: '⨀',
  quad: '    ', qquad: '        ', ',': ' ', ';': ' ', ':': ' ', '!': '',
  '{': '{', '}': '}', '\\': '  ', '$': '$', '%': '%', '&': '  ', '#': '#', '_': '_',
};

export const UPRIGHT_FUNCTIONS = new Set([
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'min', 'max', 'arg', 'arginf', 'sup', 'inf', 'lim', 'limsup', 'liminf',
  'det', 'dim', 'ker', 'deg', 'gcd', 'Pr', 'tr', 'diag', 'rank', 'sgn',
]);

export const BLACKBOARD_LETTERS: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ', H: 'ℍ',
};

const CALLIGRAPHIC: Record<string, string> = (() => {
  const from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const to = '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏';
  const out: Record<string, string> = {};
  [...from].forEach((c, i) => { out[c] = [...to][i]; });
  return out;
})();

const BLACKBOARD_CHARS: Record<string, string> = (() => {
  const upperFrom = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const upperTo = '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ';
  const lowerFrom = 'abcdefghijklmnopqrstuvwxyz';
  const lowerTo = '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫';
  const out: Record<string, string> = {};
  [...upperFrom].forEach((c, i) => { out[c] = [...upperTo][i]; });
  [...lowerFrom].forEach((c, i) => { out[c] = [...lowerTo][i]; });
  return out;
})();

export const BIG_OPS = new Set(['sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'bigcup', 'bigcap', 'bigoplus', 'bigodot']);
export const MATH_ACCENTS: Record<string, string> = { hat: '^', bar: '‾', tilde: '~', vec: '→', dot: '˙', ddot: '¨' };

// MARK: - 解析器

class Parser {
  private pos = 0;
  constructor(private chars: string[]) {}

  static parse(latex: string): { nodes: MathNode[]; supported: boolean } {
    const p = new Parser([...(latex ?? '')]);
    const nodes = p.parseGroup(null);
    return { nodes, supported: !nodes.some(isUnsupported) };
  }

  private get current(): string | null { return this.pos < this.chars.length ? this.chars[this.pos] : null; }
  private isLetter(ch: string): boolean { return /\p{L}/u.test(ch); }

  private parseGroup(terminator: string | null): MathNode[] {
    const out: MathNode[] = [];
    for (;;) {
      const ch = this.current;
      if (ch === null) return out;
      if (terminator !== null && ch === terminator) { this.pos += 1; return out; }
      const node = this.parseNode();
      if (node) out.push(node);
    }
  }

  private parseNode(): MathNode | null {
    const ch = this.current;
    if (ch === null) return null;
    if (ch === '{') { this.pos += 1; return { kind: 'group', items: this.parseGroup('}') }; }
    if (ch === '}') { this.pos += 1; return null; }   // 多余右括号：忽略而不是崩
    if (ch === '^' || ch === '_') {
      this.pos += 1;
      const script = this.parseSingle();
      // 孤立的上/下标（没有底数）：挂在空组上，保持视觉位置
      return ch === '^'
        ? { kind: 'script', base: { kind: 'group', items: [] }, sub: null, sup: script }
        : { kind: 'script', base: { kind: 'group', items: [] }, sub: script, sup: null };
    }
    const node = this.parseSingle();
    if (this.current === '^' || this.current === '_') {
      let sub: MathNode | null = null, sup: MathNode | null = null;
      while (this.current === '^' || this.current === '_') {
        const n = this.current; this.pos += 1;
        const value = this.parseSingle();
        if (n === '^') sup = value; else sub = value;
      }
      if (node.kind === 'bigOp') return { kind: 'bigOp', op: node.op, sub: sub ?? node.sub, sup: sup ?? node.sup };
      return { kind: 'script', base: node, sub, sup };
    }
    return node;
  }

  private parseSingle(): MathNode {
    const ch = this.current;
    if (ch === null) return { kind: 'text', value: '' };
    if (ch === '\\') return this.parseCommand();
    if (ch === '{') { this.pos += 1; return { kind: 'group', items: this.parseGroup('}') }; }
    this.pos += 1;
    return { kind: 'text', value: ch };
  }

  private readCommand(): string {
    this.pos += 1; // 跳过反斜杠
    let name = '';
    while (this.current !== null && this.isLetter(this.current)) { name += this.current; this.pos += 1; }
    if (name === '' && this.current !== null && !/\s/.test(this.current)) {
      name = this.current; this.pos += 1; // 单字符命令（\, \; \{ 等）
    }
    return name;
  }

  /**
   * 解析 \text/\mathrm/\mathbb 等命令的纯文本参数。
   * 参数里含未知命令时返回 null（调用方须整式降级）——绝不能把 flatten 出的原始源码
   * 当成已排版内容，那会把残缺公式渲染得像对的。
   */
  private parseTextArg(): string | null {
    const node = this.parseSingle();
    // 参数里含上下标/分数/根式时必须整式降级：flattenNode 对这些结构只保留
    // base/分子/被开方数（\mathrm{x^2} 会flatten成 "x"），静默丢内容比不排版更糟——
    // 它把残缺公式渲染得像对的，与本文件「绝不半渲染半猜测」的纪律直接冲突。
    if (isUnsupported(node) || losesContentOnFlatten(node)) return null;
    return flattenNode(node);
  }

  private parseSingleOrDelimiter(): MathNode | null {
    const ch = this.current;
    if (ch === null) return null;
    if (ch === '\\') return this.parseCommand();
    if (ch === '.') { this.pos += 1; return { kind: 'group', items: [] }; } // \left. 空定界符
    this.pos += 1;
    return { kind: 'text', value: ch };
  }

  private parseCommand(): MathNode {
    const name = this.readCommand();
    if (!name) return { kind: 'text', value: '' };
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return { kind: 'frac', a: this.parseSingle(), b: this.parseSingle() };
      case 'sqrt': {
        if (this.current === '[') {
          this.pos += 1;
          let raw = '';
          let c: string | null = this.current;
          while (c !== null && c !== ']') { raw += c; this.pos += 1; c = this.current; }
          if (c === ']') this.pos += 1;
          return { kind: 'root', a: this.parseSingle(), index: { kind: 'group', items: Parser.parse(raw).nodes } };
        }
        return { kind: 'root', a: this.parseSingle(), index: null };
      }
      case 'overline': return { kind: 'overline', a: this.parseSingle() };
      case 'underline': return { kind: 'overline', a: this.parseSingle() };
      case 'mathbf': case 'bm': case 'boldsymbol': return { kind: 'bold', a: this.parseSingle() };
      case 'mathbb': {
        // 内部含未知命令时必须整式降级：不能把 flatten 后的原始源码当成已排版内容。
        const inner = this.parseTextArg();
        if (inner === null) return { kind: 'unsupported', raw: '\\' + name };
        return { kind: 'text', value: [...inner].map((c) => BLACKBOARD_CHARS[c] ?? c).join('') };
      }
      case 'mathcal': case 'mathscr': {
        const inner = this.parseTextArg();
        if (inner === null) return { kind: 'unsupported', raw: '\\' + name };
        return { kind: 'calligraphic', value: [...inner].map((c) => CALLIGRAPHIC[c] ?? c).join('') };
      }
      case 'mathit': {
        const inner = this.parseTextArg();
        return inner === null ? { kind: 'unsupported', raw: '\\' + name } : { kind: 'text', value: inner };
      }
      case 'mathrm': case 'mathsf': case 'mathtt': case 'text': case 'textrm': case 'operatorname': case 'mbox': {
        const inner = this.parseTextArg();
        return inner === null ? { kind: 'unsupported', raw: '\\' + name } : { kind: 'upright', value: inner };
      }
      case 'bmod': case 'mod': return { kind: 'upright', value: 'mod' };
      case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'Bigg':
      case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': case 'biggl': case 'biggr': case 'Biggl': case 'Biggr':
        return this.parseSingleOrDelimiter() ?? { kind: 'group', items: [] };
      case 'begin': case 'end':
        return { kind: 'unsupported', raw: '\\' + name }; // 矩阵/多行环境：不猜，标不支持
      default: {
        const accent = MATH_ACCENTS[name];
        if (accent) return { kind: 'accent', a: this.parseSingle(), accent };
        const symbol = MATH_SYMBOLS[name];
        if (symbol !== undefined) {
          if (BIG_OPS.has(name)) return { kind: 'bigOp', op: symbol, sub: null, sup: null };
          return { kind: 'symbol', value: symbol };
        }
        if (UPRIGHT_FUNCTIONS.has(name)) return { kind: 'upright', value: name };
        const bb = BLACKBOARD_LETTERS[name];
        if (bb) return { kind: 'text', value: bb };
        return { kind: 'unsupported', raw: '\\' + name };
      }
    }
  }
}

/** flattenNode 是否会丢失该节点的内容（script 丢上下标、frac 丢分母、root 丢根号/指数、bigOp 丢 limits）。 */
export function losesContentOnFlatten(node: MathNode): boolean {
  switch (node.kind) {
    case 'script': case 'frac': case 'root': case 'bigOp': return true;
    case 'group': return node.items.some(losesContentOnFlatten);
    case 'bold': case 'blackboard': case 'overline': case 'accent': return losesContentOnFlatten(node.a);
    default: return false;
  }
}

/** 取节点的纯文本（用于 \mathrm/\text 等命令参数）。 */
export function flattenNode(node: MathNode): string {
  switch (node.kind) {
    case 'text': case 'upright': case 'symbol': case 'calligraphic': return node.value;
    case 'group': return node.items.map(flattenNode).join('');
    case 'bold': case 'blackboard': case 'overline': return flattenNode(node.a);
    case 'accent': return flattenNode(node.a);
    case 'script': return flattenNode(node.base);
    case 'frac': return flattenNode(node.a);
    case 'root': return flattenNode(node.a);
    case 'bigOp': return node.op;
    case 'unsupported': return node.raw;
  }
}

export function parseMath(latex: string): { nodes: MathNode[]; supported: boolean } {
  return Parser.parse(latex);
}

// MARK: - Unicode 扁平化（简单公式随正文换行）

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
  p: 'ₚ', s: 'ₛ', t: 'ₜ', i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ',
};
const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', t: 'ᵗ', '*': '＊',
};

function mapChars(s: string, table: Record<string, string>): string | null {
  let out = '';
  for (const ch of s) {
    const m = table[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out === '' ? null : out;
}

/** 把「简单」公式压成带 Unicode 上下标的纯文本；复杂结构（分数/根号/大算子）返回 null。 */
export function flattenUnicode(nodes: MathNode[]): string | null {
  let out = '';
  for (const node of nodes) {
    const piece = flattenOne(node);
    if (piece === null) return null;
    out += piece;
  }
  return out === '' ? null : out;
}

function flattenOne(node: MathNode): string | null {
  switch (node.kind) {
    case 'text': case 'symbol': case 'upright': case 'calligraphic': return node.value;
    case 'group': return flattenUnicode(node.items);
    case 'bold': case 'blackboard': case 'overline': return flattenOne(node.a);
    case 'accent': return flattenOne(node.a);
    case 'script': {
      let text = flattenOne(node.base);
      if (text === null) return null;
      if (node.sub) {
        const s = flattenOne(node.sub);
        const mapped = s === null ? null : mapChars(s, SUBSCRIPT_MAP);
        if (mapped === null) return null;
        text += mapped;
      }
      if (node.sup) {
        const s = flattenOne(node.sup);
        const mapped = s === null ? null : mapChars(s, SUPERSCRIPT_MAP);
        if (mapped === null) return null;
        text += mapped;
      }
      return text;
    }
    case 'unsupported': return null;
    case 'frac': case 'root': case 'bigOp': return null;
  }
}

// MARK: - 宽度/高度估算（纯函数，供缩放与滚动决策）

function textWidth(s: string, size: number): number { return [...s].length * size * 0.52; }

export function nodeWidth(node: MathNode, size: number): number {
  switch (node.kind) {
    case 'text': case 'upright': case 'symbol': case 'calligraphic': return textWidth(node.value, size);
    case 'bigOp': {
      const limits = Math.max(node.sub ? nodeWidth(node.sub, size * 0.7) : 0, node.sup ? nodeWidth(node.sup, size * 0.7) : 0);
      return Math.max(size * 0.9, limits);
    }
    case 'script': {
      const b = nodeWidth(node.base, size);
      const s = Math.max(node.sub ? nodeWidth(node.sub, size * 0.7) : 0, node.sup ? nodeWidth(node.sup, size * 0.7) : 0);
      return b + s * 0.85;
    }
    case 'frac':
      return Math.max(nodeWidth(node.a, size * 0.95), nodeWidth(node.b, size * 0.95)) + size * 0.3;
    case 'root':
      return nodeWidth(node.a, size) + size * 0.8 + (node.index ? nodeWidth(node.index, size * 0.6) : 0);
    case 'overline': case 'bold': case 'blackboard':
      return nodeWidth(node.a, size) + size * 0.1;
    case 'accent': return nodeWidth(node.a, size);
    case 'group': return nodesWidth(node.items, size);
    case 'unsupported': return [...node.raw].length * size * 0.5;
  }
}
export function nodesWidth(nodes: MathNode[], size: number): number {
  return nodes.reduce((sum, n) => sum + nodeWidth(n, size), 0);
}

export function nodeHeight(node: MathNode, size: number): number {
  switch (node.kind) {
    case 'frac': return nodeHeight(node.a, size * 0.92) + nodeHeight(node.b, size * 0.92) + size * 0.3;
    case 'root': return Math.max(nodeHeight(node.a, size) + size * 0.3, node.index ? nodeHeight(node.index, size * 0.55) + size * 0.6 : 0);
    case 'bigOp':
      return size * 1.7 + (node.sub ? nodeHeight(node.sub, size * 0.7) : 0) + (node.sup ? nodeHeight(node.sup, size * 0.7) : 0) + size * 0.15;
    case 'script': {
      const scripts = Math.max(node.sub ? nodeHeight(node.sub, size * 0.7) : 0, node.sup ? nodeHeight(node.sup, size * 0.7) : 0);
      return Math.max(nodeHeight(node.base, size), scripts + size * 0.9) + size * 0.6;
    }
    case 'group': return nodesHeight(node.items, size);
    case 'bold': case 'blackboard': return nodeHeight(node.a, size);
    case 'overline': return nodeHeight(node.a, size) + size * 0.15;
    case 'accent': return nodeHeight(node.a, size) + size * 0.75;
    default: return size * 1.25;
  }
}
export function nodesHeight(nodes: MathNode[], size: number): number {
  return nodes.reduce((h, n) => Math.max(h, nodeHeight(n, size)), 0);
}

// MARK: - 分段（正文 / 行内公式 / 独立公式块）—— 移植自 MathSegmenter

export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'inlineMath'; latex: string }
  | { kind: 'blockMath'; latex: string };

/** 支持 $$…$$、\[…\]、\(…\)、$…$；未闭合的定界符按普通文本处理（不吞正文）。 */
export function segmentMath(text: string): MathSegment[] {
  const out: MathSegment[] = [];
  let buffer = '';
  let i = 0;
  const s = text ?? '';
  const flushText = (): void => { if (buffer) { out.push({ kind: 'text', value: buffer }); buffer = ''; } };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '$') {
      if (s[i + 1] === '$') {
        const bodyStart = i + 2;
        const end = s.indexOf('$$', bodyStart);
        if (end >= 0) {
          flushText();
          out.push({ kind: 'blockMath', latex: s.slice(bodyStart, end).trim() });
          i = end + 2;
          continue;
        }
        buffer += '$$'; i = bodyStart; continue;
      }
      const end = s.indexOf('$', i + 1);
      if (end >= 0) {
        const body = s.slice(i + 1, end);
        if (body && !/^\s/.test(body) && !body.includes('\n')) {
          flushText();
          out.push({ kind: 'inlineMath', latex: body });
          i = end + 1;
          continue;
        }
      }
      buffer += '$'; i += 1; continue;
    }
    if (ch === '\\') {
      if (s[i + 1] === '[') {
        const bodyStart = i + 2;
        const end = s.indexOf('\\]', bodyStart);
        if (end >= 0) { flushText(); out.push({ kind: 'blockMath', latex: s.slice(bodyStart, end).trim() }); i = end + 2; continue; }
        buffer += '\\['; i = bodyStart; continue;
      }
      if (s[i + 1] === '(') {
        const bodyStart = i + 2;
        const end = s.indexOf('\\)', bodyStart);
        if (end >= 0) { flushText(); out.push({ kind: 'inlineMath', latex: s.slice(bodyStart, end) }); i = end + 2; continue; }
        buffer += '\\('; i = bodyStart; continue;
      }
    }
    buffer += ch; i += 1;
  }
  flushText();
  return out;
}

/** 整行是否为独立公式（$$…$$ / \[…\]），供 Markdown 分块使用。 */
export function blockMathLine(trimmed: string): string | null {
  const t = (trimmed ?? '').trim();
  if (t.startsWith('$$') && t.endsWith('$$') && t.length > 4) return t.slice(2, -2).trim();
  if (t.startsWith('\\[') && t.endsWith('\\]') && t.length > 4) return t.slice(2, -2).trim();
  return null;
}

// MARK: - 渲染为 HTML（对齐 macOS MathNodeView 的结构）

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hasLetters(s: string): boolean { return /\p{L}/u.test(s); }

/** 节点的 HTML；style 里用 em 保证随字号缩放。 */
export function mathNodeHTML(node: MathNode): string {
  switch (node.kind) {
    case 'text':
      return hasLetters(node.value) ? `<span class="m-i">${esc(node.value)}</span>` : `<span class="m-t">${esc(node.value)}</span>`;
    case 'symbol':
      return `<span class="m-i">${esc(node.value)}</span>`;
    case 'upright':
      return `<span class="m-r">${esc(node.value)}</span>`;
    case 'calligraphic':
      return `<span class="m-cal">${esc(node.value)}</span>`;
    case 'group':
      return `<span class="m-grp">${node.items.map(mathNodeHTML).join('')}</span>`;
    case 'bold':
      return `<span class="m-b">${mathNodeHTML(node.a)}</span>`;
    case 'blackboard':
      return mathNodeHTML(node.a);
    case 'accent':
      return `<span class="m-acc"><span class="m-acc-mark">${esc(node.accent)}</span><span class="m-acc-base">${mathNodeHTML(node.a)}</span></span>`;
    case 'overline':
      return `<span class="m-ovl">${mathNodeHTML(node.a)}</span>`;
    case 'script': {
      const sub = node.sub ? `<span class="m-sub">${mathNodeHTML(node.sub)}</span>` : '';
      const sup = node.sup ? `<span class="m-sup">${mathNodeHTML(node.sup)}</span>` : '';
      const scripts = (sub || sup) ? `<span class="m-scripts">${sup}${sub}</span>` : '';
      return `<span class="m-scr">${mathNodeHTML(node.base)}${scripts}</span>`;
    }
    case 'bigOp': {
      const sup = node.sup ? `<span class="m-lim-sup">${mathNodeHTML(node.sup)}</span>` : '';
      const sub = node.sub ? `<span class="m-lim-sub">${mathNodeHTML(node.sub)}</span>` : '';
      return `<span class="m-bigop">${sup}<span class="m-op">${esc(node.op)}</span>${sub}</span>`;
    }
    case 'frac':
      return `<span class="m-frac"><span class="m-num">${mathNodeHTML(node.a)}</span><span class="m-den">${mathNodeHTML(node.b)}</span></span>`;
    case 'root': {
      const idx = node.index ? `<span class="m-root-idx">${mathNodeHTML(node.index)}</span>` : '';
      return `<span class="m-root">${idx}<span class="m-rad">√</span><span class="m-radicand">${mathNodeHTML(node.a)}</span></span>`;
    }
    case 'unsupported':
      return `<span class="m-unsup">${esc(node.raw)}</span>`;
  }
}

export interface MathHTML { html: string; supported: boolean }

/**
 * 渲染独立公式块：支持则不溢出（放不下横向滚动）；不支持则**整式**降级为原始 LaTeX。
 * 降级源码默认收起（与 macOS 一致：不明文展示）。
 */
export function mathBlockHTML(latex: string): MathHTML {
  const { nodes, supported } = parseMath(latex);
  if (supported && nodes.length) {
    return { html: `<span class="m-math m-block">${nodes.map(mathNodeHTML).join('')}</span>`, supported: true };
  }
  return { html: fallbackHTML(latex), supported: false };
}

/** 行内公式：先试 Unicode 扁平化（可随正文换行），否则用节点渲染。 */
export function mathInlineHTML(latex: string): MathHTML {
  const { nodes, supported } = parseMath(latex);
  if (supported && nodes.length) {
    const flat = flattenUnicode(nodes);
    if (flat !== null) return { html: `<span class="m-flat">${esc(flat)}</span>`, supported: true };
    return { html: `<span class="m-math m-inline">${nodes.map(mathNodeHTML).join('')}</span>`, supported: true };
  }
  return { html: fallbackHTML(latex), supported: false };
}

/** 无法排版时的回退：提示 + 可展开的原始源码（默认收起）。 */
export function fallbackHTML(latex: string): string {
  return `<span class="m-fallback"><span class="m-fb-note">该公式无法完整排版，已收起源码；请对照原文核对</span>`
    + `<details class="m-fb-src"><summary>查看源码</summary><pre>${esc(latex)}</pre></details></span>`;
}

/**
 * 行内混排：把一段文本按「正文 / 行内公式 / 独立公式」分段渲染。
 * `renderText` 由调用方提供（复用既有 Markdown 行内渲染，避免重复实现）。
 */
export function renderRichHTML(text: string, renderText: (s: string) => string): string {
  return segmentMath(text).map((seg) => {
    if (seg.kind === 'text') return renderText(seg.value);
    if (seg.kind === 'inlineMath') return mathInlineHTML(seg.latex).html;
    return mathBlockHTML(seg.latex).html;
  }).join('');
}
