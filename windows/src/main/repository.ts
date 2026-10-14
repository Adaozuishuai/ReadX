// GitHub 公开仓库扫描（PRD 4.9），移植自 macOS RepositoryService.scan。
//
// 只读公开仓库；固定 commit（默认分支 → commit → 递归文件树 → blob）。
// token 只进请求头，不进 prompt / 日志 / 导出（PRD 8.3）。不执行仓库代码。

import {
  parseRepository, repoSlug, fileCategory, selectFiles, eligible,
  CodeFile, CodeSnapshot, TreeItem, CodeError,
} from '../core/codeMapping';

const API = 'https://api.github.com/';
const MAX_TEXT = 18_000;

interface GhTree { tree: TreeItem[]; truncated: boolean }

async function ghGet<T>(path: string, token?: string | null): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const resp = await fetch(API + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CBCT-Research-Copilot-Windows',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: ac.signal,
    });
    if (resp.status === 429 || (resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0')) {
      throw new CodeError('limited', 'GitHub 读取限额已用尽，请稍后重试；已保留旧快照。');
    }
    if (!resp.ok) throw new CodeError('http', `GitHub 返回 HTTP ${resp.status}，请核对公开仓库地址并重试。`);
    return await resp.json() as T;
  } catch (e) {
    if (e instanceof CodeError) throw e;
    if (e instanceof Error && /abort/i.test(e.message)) throw new CodeError('http', 'GitHub 请求超时，请稍后重试。');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface ScanProgress { (stage: string): void }

/**
 * 扫描公开仓库，返回固定 commit 的文本快照。
 * @param raw 仓库 URL；@param paperKey 论文 key；@param token 可选（只进请求头）
 */
export async function scanRepository(raw: string, paperKey: string, token?: string | null, progress: ScanProgress = () => {}): Promise<CodeSnapshot> {
  const repository = parseRepository(raw);
  const prefix = 'repos/' + repoSlug(repository);

  progress('解析公开仓库与固定 commit');
  const meta = await ghGet<{ default_branch?: string }>(prefix, token);
  const branch = meta.default_branch ?? 'main';
  progress('读取默认分支 commit');
  const commit = await ghGet<{ sha: string; commit: { tree: { sha: string } } }>(prefix + '/commits/' + encodeURIComponent(branch), token);
  if (!/^[0-9a-f]{40}$/.test(commit.sha)) throw new CodeError('invalidSnapshot', '仓库快照格式无效；未覆盖已保存结果。');
  progress('读取固定 commit 文件树');
  const tree = await ghGet<GhTree>(prefix + '/git/trees/' + commit.commit.tree.sha + '?recursive=1', token);

  const entries = selectFiles(tree.tree, 24);
  const paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  const files: CodeFile[] = [];
  const warnings: string[] = [];
  if (tree.truncated) warnings.push('GitHub 文件树被截断；不是完整仓库扫描');
  if (tree.tree.filter(eligible).length > entries.length) warnings.push('按类别读取优先文件；未读取的文本文件仍需核对');

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    progress(`读取文件 ${i + 1}/${entries.length} · ${item.path}`);
    try {
      const blob = await ghGet<{ encoding: string; content: string }>(prefix + '/git/blobs/' + item.sha, token);
      if (blob.encoding !== 'base64') { warnings.push('无法按 UTF-8 读取：' + item.path); continue; }
      const text = Buffer.from(blob.content, 'base64').toString('utf8');
      const clipped = text.slice(0, MAX_TEXT);
      files.push({ path: item.path, sha: item.sha, category: fileCategory(item.path), text: clipped, truncated: clipped.length < text.length });
      if (clipped.length < text.length) warnings.push('文件内容截断：' + item.path);
    } catch (e) {
      if (e instanceof CodeError && e.kind === 'limited') throw e;
      warnings.push('文件读取失败：' + item.path);
    }
  }
  if (!files.length) throw new CodeError('empty', '未读取到可分析的文本文件；PDF 阅读与其他模块仍可使用。');
  return { paperKey, repository, commit: commit.sha, scannedAt: new Date().toISOString(), paths, files, warnings, mappingJSON: null, confirmations: null, mappingSource: null };
}

/** 生成供 AI 映射用的上下文。 */
export function snapshotContext(s: CodeSnapshot): string {
  const head = `仓库：${'https://github.com/' + repoSlug(s.repository)}\ncommit：${s.commit}\n读取范围：${s.files.length}/${s.paths.length} 个文件\n`;
  const body = s.files.map((f) => `=== File ${f.path} [${f.category}] ===\n` + f.text.split('\n').map((l, i) => `${i + 1}:${l}`).join('\n')).join('\n\n');
  return head + body;
}
