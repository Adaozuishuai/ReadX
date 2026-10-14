// 高频写盘节流：首写立即执行，窗口内的后续写合并，窗口结束时写入「最新值」。
//
// 语义来自 macOS 版 Store：首写立即 / 窗口内去抖 / 退出前冲刷。
// 注意「去抖」是合并（coalesce），不是丢弃：窗口内最后一次编辑必须在窗口结束时落盘，
// 否则用户会看到「改完没报错但重启后内容没了」。

export type WriteFn = () => void;

export class ThrottledWriter {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, WriteFn>();

  /**
   * @param onError 落盘失败上报。调用方（IPC handler）早已返回 ok:true，
   *   这里是唯一能告知用户「自动保存其实没写成」的机会，绝不能静默吞掉。
   */
  constructor(private windowMs = 600, private onError?: (key: string, error: unknown) => void) {}

  schedule(key: string, write: WriteFn): void {
    this.pending.set(key, write);
    if (this.timers.has(key)) return; // 窗口已开：只更新待写值，等窗口结束
    this.flushOne(key);               // 首写立即，避免进程被杀丢数据
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.flushOne(key);             // 窗口结束：写掉合并后的最新值
    }, this.windowMs));
  }

  /** 立即写入某个 key 的待写值（若有）。 */
  flushOne(key: string): void {
    const write = this.pending.get(key);
    if (!write) return;
    this.pending.delete(key);
    try { write(); } catch (e) {
      // 不中断其它 pending，但必须上报（默认打到主进程日志）
      if (this.onError) this.onError(key, e);
      else console.error(`[ThrottledWriter] 落盘失败 ${key}:`, e);
    }
  }

  /** 退出前冲刷全部待写值。 */
  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flushOne(key);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  pendingKeys(): string[] { return [...this.pending.keys()]; }
}
