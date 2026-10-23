export interface SourcePage {
  url: string;
  text: string;
  document: Document | null;
  json: unknown;
}

interface CompiledRule {
  kind: 'css' | 'xpath' | 'json';
  selector: string;
  attr: string;
  replacements: { pattern: string; replacement: string }[];
}

function compileRule(rawValue: string): CompiledRule {
  const raw = rawValue.trim();
  const parts = raw.split('##');
  const coreRaw = parts.shift() ?? '';
  const replacements: { pattern: string; replacement: string }[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    replacements.push({ pattern: parts[index] ?? '', replacement: parts[index + 1] ?? '' });
  }

  let core = coreRaw;
  let attr = 'text';
  const attrMatch = /^(.*)@(text|ownText|html|href|src|content|alt|title|value|data-[\w-]+|[\w-]+)$/.exec(core);
  if (attrMatch && attrMatch[1] !== undefined && attrMatch[2] !== undefined) {
    core = attrMatch[1];
    attr = attrMatch[2];
  }

  let kind: CompiledRule['kind'] = 'css';
  if (/^@json:/i.test(core)) {
    kind = 'json';
    core = core.replace(/^@json:/i, '');
  } else if (/^@css:/i.test(core)) {
    kind = 'css';
    core = core.replace(/^@css:/i, '');
  } else if (/^@XPath:/i.test(core)) {
    kind = 'xpath';
    core = core.replace(/^@XPath:/i, '');
  } else if (core.startsWith('//') || core.startsWith('(/')) {
    kind = 'xpath';
  } else if (/^class\./i.test(core)) {
    core = `.${core.replace(/^class\./i, '')}`;
  } else if (/^id\./i.test(core)) {
    core = `#${core.replace(/^id\./i, '')}`;
  } else if (/^tag\./i.test(core)) {
    core = core.replace(/^tag\./i, '');
  }

  return { kind, selector: core.trim(), attr, replacements };
}

function isJsonRule(page: SourcePage, rule: string, compiled: CompiledRule): boolean {
  if (compiled.kind === 'json') return true;
  if (page.json === null) return false;
  if (/^@(css|xpath):/i.test(rule.trim())) return false;
  return !/^[.#[a-zA-Z]/.test(rule.trim()) || rule.trim().startsWith('$');
}

function isDomRoot(value: unknown): value is Document | Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('querySelectorAll' in value || 'nodeType' in value)
  );
}

function jsonPath(root: unknown, path: string): unknown {
  const cleaned = path.trim().replace(/^\$\.?/, '').replace(/^\./, '');
  if (!cleaned) return root;
  let current: unknown = root;
  for (const part of cleaned.split('.').filter(Boolean)) {
    if (part === '*') continue;
    const indexed = /^(.*)\[(\*|-?\d+)\]$/.exec(part);
    if (indexed) {
      const key = indexed[1] ?? '';
      if (key) {
        current =
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[key]
            : undefined;
      }
      const index = indexed[2] ?? '';
      if (Array.isArray(current)) {
        current = index === '*' ? current : current[Number(index)];
      }
      continue;
    }
    if (Array.isArray(current)) {
      current = current.map((item) =>
        item && typeof item === 'object' ? (item as Record<string, unknown>)[part] : undefined,
      );
      continue;
    }
    current =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[part]
        : undefined;
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function applyReplacements(
  value: string,
  replacements: { pattern: string; replacement: string }[],
): string {
  let next = value;
  for (const replacement of replacements) {
    if (!replacement.pattern) continue;
    try {
      next = next.replace(
        new RegExp(replacement.pattern, 'g'),
        replacement.replacement.replace(/\\n/g, '\n'),
      );
    } catch {
      /* 无效的书源正则直接跳过。 */
    }
  }
  return next;
}

export function selectNodes(page: SourcePage, root: unknown, rule: string): unknown[] {
  const compiled = compileRule(rule);
  if (isJsonRule(page, rule, compiled)) {
    const value = jsonPath(root, compiled.selector);
    return Array.isArray(value) ? value : [value];
  }
  if (!isDomRoot(root)) return [];
  const selector = compiled.selector;
  if (!selector) return [root];

  if (compiled.kind === 'xpath') {
    const document_ = page.document;
    if (!document_) return [];
    try {
      const result = document_.evaluate(
        selector,
        root,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const nodes: unknown[] = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        nodes.push(result.snapshotItem(index));
      }
      return nodes.filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function ownText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absolute(value: string, pageURL: string): string {
  try {
    return new URL(value, pageURL).toString();
  } catch {
    return value;
  }
}

function valueFromNode(node: unknown, attr: string, pageURL: string): string {
  if (node instanceof Attr) return node.value;
  if (node instanceof Text) return node.textContent ?? '';
  if (node instanceof Element) {
    switch (attr) {
      case 'text':
        return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      case 'ownText':
        return ownText(node);
      case 'html':
        return node.innerHTML;
      case 'href':
      case 'src': {
        const value = node.getAttribute(attr) ?? '';
        return value ? absolute(value, pageURL) : '';
      }
      case 'content':
        return node.getAttribute('content') ?? (node.textContent ?? '').trim();
      default:
        return node.getAttribute(attr) ?? '';
    }
  }
  if (node instanceof Document) return node.documentElement?.textContent ?? '';
  return '';
}

export function extractValue(page: SourcePage, root: unknown, rule: string): string {
  if (!rule.trim()) return '';
  const compiled = compileRule(rule);
  if (isJsonRule(page, rule, compiled)) {
    const value = jsonPath(root, compiled.selector);
    return applyReplacements(stringify(value), compiled.replacements).trim();
  }
  const node = selectNodes(page, root, rule)[0];
  if (node === undefined || node === null) return '';
  return applyReplacements(valueFromNode(node, compiled.attr, page.url), compiled.replacements).trim();
}

export function extractElement(page: SourcePage, root: unknown, rule: string): Element | null {
  const node = selectNodes(page, root, rule)[0];
  return node instanceof Element ? node : null;
}

/** 正文容器转纯文本：保留段落换行，去掉脚本/样式/导航。 */
export function contentToText(element: Element, removeSelector: string): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,noscript,iframe,svg,form,button,select,input').forEach((node) => node.remove());
  if (removeSelector.trim()) {
    try {
      clone.querySelectorAll(removeSelector).forEach((node) => node.remove());
    } catch {
      /* 无效的去广告选择器直接跳过。 */
    }
  }
  clone.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  clone
    .querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,blockquote,tr')
    .forEach((node) => node.append('\n'));

  return (clone.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectCharset(bytes: ArrayBuffer, contentType: string, fallback: string): string {
  if (fallback.trim()) return fallback.trim().toLowerCase();
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const prefix = new TextDecoder('latin1').decode(new Uint8Array(bytes.slice(0, 4096))).toLowerCase();
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(prefix)?.[1] ??
    /charset=([\w-]+)/i.exec(prefix)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

export function decodePage(
  url: string,
  bytes: ArrayBuffer,
  contentType: string,
  sourceCharset: string,
): SourcePage {
  const charset = detectCharset(bytes, contentType, sourceCharset);
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }

  const trimmed = text.trim();
  if (contentType.toLowerCase().includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { url, text, document: null, json: JSON.parse(text) as unknown };
    } catch {
      /* 不是合法 JSON，按 HTML 处理。 */
    }
  }

  const document_ = new DOMParser().parseFromString(text, 'text/html');
  return { url, text, document: document_, json: null };
}

export function resolvePageURL(value: string, pageURL: string): string {
  return absolute(value.trim(), pageURL);
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '');
}
