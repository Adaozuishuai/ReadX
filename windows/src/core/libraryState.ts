// 论文库状态的内存权威副本（LibraryState 的读写与节流落盘）。
//
// 从主进程抽出来是为了可测试：这条路径有两个真实缺陷风险，都必须在回归里锁住——
//
//   1) 丢失更新：不能每次改动都「重读磁盘 -> 生成快照 -> 交给节流写」。节流窗口内若发生
//      另一条写入路径（如「移入回收站」），窗口结束时落下的旧快照会把新值回滚
//      （实测：删除的论文约 600ms 后复活）。因此全部写入共享同一份内存状态。
//   2) 损坏覆盖：library.json 损坏时若静默当成空对象，下一次任何写入都会把整份文件
//      覆盖成空——违反「损坏的 JSON 不静默回退，否则下次保存会覆盖用户数据」的硬约束。
//      损坏时记录原因并让写入直接拒绝，读路径展示为空（不崩）。

import { LibraryState, defaultLibraryState } from './types';
import { readJSONStrict, saveJSON, isSafeObjectKey } from './store';
import { ThrottledWriter } from './throttle';

export type WriteResult =
  | { ok: true; state?: LibraryState }
  | { ok: false; error: string };

// states['__proto__'] = ... 会走 setter 换掉内存权威副本的原型（原型污染），
// 且该条目 JSON.stringify 时静默丢失。key 必须先过保留名检查。
const BAD_KEY: WriteResult = { ok: false, error: '非法 key（__proto__ 等保留名或空值，已拒绝）' };

export class LibraryStore {
  private cache: Record<string, LibraryState> | null = null;
  private loadError: string | null = null;
  private writer: ThrottledWriter;

  constructor(private file: string, windowMs = 600, onError?: (key: string, error: unknown) => void) {
    this.writer = new ThrottledWriter(windowMs, onError);
  }

  /** 载入内存权威副本。缺文件视作空（首次使用不是错误）；损坏记录原因。 */
  private load(): Record<string, LibraryState> {
    if (this.cache) return this.cache;
    const r = readJSONStrict<Record<string, LibraryState>>(this.file);
    if (r.ok) { this.cache = r.value; return this.cache; }
    if (r.missing) { this.cache = {}; return this.cache; }
    this.loadError = r.error;
    this.cache = {};
    return this.cache;
  }

  /** 文件损坏原因；非 null 时一切写入被拒绝。 */
  error(): string | null {
    this.load();
    return this.loadError;
  }

  /** 只读副本（供列表/统计读取）。 */
  all(): Record<string, LibraryState> {
    return this.load();
  }

  set(key: string, patch: Partial<LibraryState>): WriteResult {
    if (!isSafeObjectKey(key)) return BAD_KEY;
    this.load();
    if (this.loadError) return { ok: false, error: `论文库状态文件已损坏，未保存以免覆盖：${this.loadError}` };
    const states = this.cache as Record<string, LibraryState>;
    const cur = states[key] ?? defaultLibraryState();
    // 时间戳去掉毫秒，与 ISO8601DateFormatter 的写法一致，避免同一秒两种格式
    states[key] = { ...cur, ...patch, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    this.persist();
    return { ok: true, state: states[key] };
  }

  /** 回收站语义：标记 deleted，不物理删除，可在库中恢复。 */
  remove(key: string): WriteResult {
    if (!isSafeObjectKey(key)) return BAD_KEY;
    this.load();
    if (this.loadError) return { ok: false, error: `论文库状态文件已损坏，未保存以免覆盖：${this.loadError}` };
    const states = this.cache as Record<string, LibraryState>;
    states[key] = { ...(states[key] ?? defaultLibraryState()), status: 'deleted' };
    this.persist();
    return { ok: true, state: states[key] };
  }

  /** 从回收站恢复为未读。 */
  restore(key: string): WriteResult {
    if (!isSafeObjectKey(key)) return BAD_KEY;
    this.load();
    if (this.loadError) return { ok: false, error: `论文库状态文件已损坏，未保存以免覆盖：${this.loadError}` };
    const states = this.cache as Record<string, LibraryState>;
    states[key] = { ...(states[key] ?? defaultLibraryState()), status: 'unread' };
    this.persist();
    return { ok: true, state: states[key] };
  }

  /** 彻底删除：移除该论文的全部本地状态（标签/笔记/纠错/反馈），不可恢复。 */
  purge(key: string): WriteResult {
    if (!isSafeObjectKey(key)) return BAD_KEY;
    this.load();
    if (this.loadError) return { ok: false, error: `论文库状态文件已损坏，未保存以免覆盖：${this.loadError}` };
    const states = this.cache as Record<string, LibraryState>;
    delete states[key];
    this.persist();
    return { ok: true };
  }

  private persist(): void {
    const snapshot = this.cache as Record<string, LibraryState>;
    this.writer.schedule('library', () => saveJSON(this.file, snapshot));
  }

  /** 退出前必须冲刷，否则窗口关闭会丢最后一次编辑。 */
  flush(): void {
    this.writer.flushAll();
  }
}
