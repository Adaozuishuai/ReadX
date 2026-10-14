// 论文 ↔ 代码映射（PRD 4.9），移植自 macOS RepositoryService.swift 与 CodeModels.swift。
//
// 纯逻辑部分（仓库地址解析、文件分类、可读文件筛选、往返选文件、映射校验）在这里实现，
// 便于回归测试；网络扫描（GitHub API）在 main/repository.ts。
//
// 硬约束（沿用 evidence-first）：
//  - 只接受不含凭据的公开 GitHub 仓库 URL；
//  - 代码摘录必须能在所声明的行范围内逐字（忽略缩进）找到，symbol 必须出现在文件里；
//  - 每条映射都要有论文页码依据与 [0,1] 置信度；
//  - token 只进请求头，不进 prompt / 日志 / 导出。

export interface RepositoryID { owner: string; name: string }
export function repoSlug(r: RepositoryID): string { return r.owner + '/' + r.name; }
export function repoUrl(r: RepositoryID): string { return 'https://github.com/' + repoSlug(r); }

export class CodeError extends Error {
  constructor(public kind: string, message: string) { super(message); this.name = 'CodeError'; }
}

/** 解析公开 GitHub 仓库 URL。拒绝凭据、查询串、片段、端口，只允许 https。 */
export function parseRepository(raw: string): RepositoryID {
  const s = (raw ?? '').trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new CodeError('invalidRepository', '请输入不含凭据的公开 GitHub 仓库 URL：https://github.com/owner/repo'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || u.username || u.password || u.search || u.hash || u.port) {
    throw new CodeError('invalidRepository', '请输入不含凭据的公开 GitHub 仓库 URL：https://github.com/owner/repo');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..')) {
    throw new CodeError('invalidRepository', '请输入不含凭据的公开 GitHub 仓库 URL：https://github.com/owner/repo');
  }
  let name = parts[1];
  if (name.endsWith('.git')) name = name.slice(0, -4);
  if (!name || name === '.' || name === '..') throw new CodeError('invalidRepository', '请输入不含凭据的公开 GitHub 仓库 URL：https://github.com/owner/repo');
  return { owner: parts[0], name };
}

export function sameRepo(a: RepositoryID, b: RepositoryID): boolean {
  return a.owner === b.owner && a.name === b.name;
}

/** 文件分类（与 macOS category 一致，决定往返选顺序）。 */
export function fileCategory(path: string): string {
  const p = (path ?? '').toLowerCase();
  const name = p.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (name.startsWith('readme') || name.startsWith('license')) return 'README / 许可';
  if (name.includes('requirement') || name.includes('environment') || ['setup.py', 'pyproject.toml', 'cmakelists.txt', 'package.json'].includes(name)) return '环境 / 依赖';
  if (p.includes('config') || ['yaml', 'yml', 'toml', 'json'].includes(ext)) return '配置';
  if (p.includes('dataset') || p.includes('dataloader') || p.includes('preprocess') || p.includes('data/')) return 'Dataset / 预处理';
  if (p.includes('loss')) return 'Loss';
  if (p.includes('train')) return '训练入口';
  if (p.includes('eval') || p.includes('infer') || p.includes('test')) return '推理 / 评测';
  if (p.includes('model') || p.includes('network') || p.includes('encoder') || p.includes('render') || p.includes('geometry')) return '模型 / 几何';
  return '其他实现';
}

export interface TreeItem { path: string; mode: string; type: string; sha: string; size?: number | null }

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const SECRET_HINTS = ['secret', 'credential', '.env', 'id_rsa', 'token', 'apikey', 'api_key'];
const TEXT_EXTS = new Set(['md', 'rst', 'txt', 'py', 'yaml', 'yml', 'toml', 'json', 'cpp', 'cu', 'h', 'sh']);
const MAX_FILE_BYTES = 150_000;

/** 可读取的文本文件：排除二进制、密钥、依赖目录与超大文件。 */
export function eligible(item: TreeItem): boolean {
  const p = (item.path ?? '').toLowerCase();
  const comps = p.split('/');
  if (item.type !== 'blob') return false;
  if (!['100644', '100755'].includes(item.mode)) return false;
  if ((item.size ?? 0) >= MAX_FILE_BYTES) return false;
  if (comps.some((c) => SKIP_DIRS.has(c))) return false;
  if (SECRET_HINTS.some((h) => p.includes(h))) return false;
  if (comps.includes('..')) return false;
  const name = p.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return TEXT_EXTS.has(ext) || p.endsWith('license') || p.endsWith('cmakelists.txt');
}

const CATEGORY_ORDER = ['README / 许可', '环境 / 依赖', '配置', 'Dataset / 预处理', 'Loss', '训练入口', '推理 / 评测', '模型 / 几何', '其他实现'];

function filePriority(path: string): number {
  const name = (path ?? '').toLowerCase().split('/').pop() ?? '';
  if (name === '__init__.py') return 100;
  if (name.startsWith('readme')) return 0;
  if (['network.py', 'model.py', 'render.py', 'loss.py', 'train.py', 'tigre.py', 'hashgrid.py'].includes(name)) return 1;
  if (name === 'backend.py' || name === 'license') return 10;
  return 5;
}

/** 按类别往返选取，避免大 config 目录挤掉 model/loss。与 macOS selected 一致。 */
export function selectFiles(items: TreeItem[], limit = 24): TreeItem[] {
  const files = items.filter(eligible).sort((a, b) => (filePriority(a.path) === filePriority(b.path) ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : filePriority(a.path) - filePriority(b.path)));
  const groups = CATEGORY_ORDER.map((c) => files.filter((f) => fileCategory(f.path) === c));
  const out: TreeItem[] = [];
  while (out.length < limit && groups.some((g) => g.length > 0)) {
    for (let i = 0; i < groups.length && out.length < limit; i++) {
      if (groups[i].length) out.push(groups[i].shift()!);
    }
  }
  return out;
}

export interface CodeFile { path: string; sha: string; category: string; text: string; truncated: boolean }
export function fileLines(f: CodeFile): string[] { return f.text.split('\n'); }
export function fileNumbered(f: CodeFile): string { return fileLines(f).map((l, i) => `${i + 1}:${l}`).join('\n'); }

export interface CodeSnapshot {
  paperKey: string;
  repository: RepositoryID;
  commit: string;
  scannedAt: string;
  paths: string[];
  files: CodeFile[];
  warnings: string[];
  mappingJSON?: string | null;
  confirmations?: Record<string, string> | null;
  mappingSource?: string | null;
}

export interface CodeMapping {
  concept: string;
  paper: { k: string; v: string; page?: number | null; excerpt?: string | null };
  path: string;
  startLine: number;
  endLine: number;
  codeExcerpt: string;
  symbol: string;
  reasoning: string;
  confidence: number;
  id: string;
}
export interface CodeMappingAnalysis { mappings: CodeMapping[]; missing: string[] }

export function mappingID(m: Pick<CodeMapping, 'concept' | 'path' | 'startLine'>): string {
  return m.concept + '|' + m.path + '|' + String(m.startLine);
}

/** 只归一行首缩进，保留运算符与字符串内容（与 macOS codeNormalized 一致）。 */
export function codeNormalized(text: string): string {
  return (text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/^\s+|\s+$/g, '')).join('\n').replace(/^\s+|\s+$/g, '');
}

export function decodeCodeMapping(raw: string): CodeMappingAnalysis {
  let text = (raw ?? '').trim();
  // 从可能夹带说明文字的回复里抽出第一个 JSON 对象
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  else if (text.startsWith('```')) text = text.split('\n').slice(1, -1).join('\n');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { throw new CodeError('invalidEvidence', '代码映射不是合法 JSON：' + (e instanceof Error ? e.message : String(e))); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CodeError('invalidEvidence', '代码映射必须是 JSON 对象。');
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.mappings)) throw new CodeError('invalidEvidence', '代码映射缺少 mappings 数组。');
  if (!Array.isArray(obj.missing)) obj.missing = [];
  return parsed as CodeMappingAnalysis;
}

/** 与 PDF 缓存无关的那部分校验：行范围、逐字摘录、symbol、页码与置信度。 */
export function validateCodeMapping(analysis: CodeMappingAnalysis, snapshot: CodeSnapshot): void {
  if (!analysis.mappings.length) throw new CodeError('invalidEvidence', '没有可核对的映射');
  const ids = new Set(analysis.mappings.map(mappingID));
  if (ids.size !== analysis.mappings.length) throw new CodeError('invalidEvidence', '重复映射');
  for (const m of analysis.mappings) {
    if (!m.concept || !m.reasoning || !Number.isFinite(m.confidence) || m.confidence < 0 || m.confidence > 1 || m.paper?.page == null) {
      throw new CodeError('invalidEvidence', (m.concept || '(无概念)') + ' 缺少论文依据或有效置信度');
    }
    const file = snapshot.files.find((f) => f.path === m.path);
    const lines = file ? fileLines(file) : null;
    if (!file || !lines || !(m.startLine > 0) || !(m.endLine >= m.startLine) || m.endLine > lines.length) {
      throw new CodeError('invalidEvidence', m.path + ' 不存在或行号超出范围');
    }
    const slice = lines.slice(m.startLine - 1, m.endLine).join('\n');
    const excerptOk = codeNormalized(m.codeExcerpt).length >= 8 && codeNormalized(slice).includes(codeNormalized(m.codeExcerpt));
    const symbolOk = !m.symbol || m.symbol === '未知' || file.text.includes(m.symbol);
    if (!excerptOk || !symbolOk) {
      throw new CodeError('invalidEvidence',
        `${m.path}:${m.startLine}–${m.endLine} 摘录/符号未匹配代码范围。该行范围实际内容：\n${slice.slice(0, 2000)}\n请复制范围内连续代码，不得改写空白以外的字符；symbol 使用原文件定义名或未知。`);
    }
  }
}

/** GitHub blob URL（固定 commit + 行号）。 */
export function fileURL(snapshot: CodeSnapshot, path: string, line?: number | null): string | null {
  if (!snapshot.paths.includes(path)) return null;
  if (path.split('/').some((c) => c === '..')) return null;
  const encoded = path.split('/').map((c) => encodeURIComponent(c).replace(/[#?]/g, (x) => '%' + x.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return repoUrl(snapshot.repository) + '/blob/' + snapshot.commit + '/' + encoded + (line ? '#L' + line : '');
}
