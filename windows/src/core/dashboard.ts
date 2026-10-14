// 工作台聚合（复刻 macOS 版 Store 的派生量）。
//
// 这些都是「从已有数据算出来」的只读量，抽成纯函数便于回归测试与复用：
//   - streak：连续阅读天数（按 progress.doneAt 日期连续计数）
//   - today：今天该读哪篇（优先未完成的有笔记论文，否则评分最高的未读论文）
//   - topicGroups / topicCounts：主题流分组与计数
//
// 口径与 macOS 版一致，避免两端「连续天数 / 今日推荐」显示不同。

import { QueueEntry, LibraryState } from './types';
import { PROFILE_KEYWORDS } from './types';

export interface ProgressEntry {
  startedAt?: string | null;
  step?: number | null;
  doneAt?: string | null;
  reflections?: Record<string, string> | null;
  freeNote?: string | null;
  critiqueLog?: Array<{ role: string; text: string }> | null;
}

export type ProgressMap = Record<string, ProgressEntry>;

/** 本地日期 yyyy-MM-dd（与 macOS 版 DateFormatter "yyyy-MM-dd" 本地时区一致）。 */
export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 连续阅读天数：从今天（若今天没读则从昨天）往前数连续「已读完」的日期。
 * 与 macOS 版 ComputeStreak 同口径。
 */
export function streak(progress: ProgressMap, today = new Date()): number {
  const days = new Set<string>();
  for (const entry of Object.values(progress)) {
    const done = entry?.doneAt;
    if (done) days.add(String(done).slice(0, 10));
  }
  let n = 0;
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!days.has(localDay(d))) d.setDate(d.getDate() - 1);
  while (days.has(localDay(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** 本周（周一至周日）的日期与完成情况，供连续阅读卡片画格子。 */
export function weekDays(progress: ProgressMap, today = new Date()): Array<{ day: string; done: boolean; label: string }> {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const days = new Set<string>();
  for (const entry of Object.values(progress)) {
    if (entry?.doneAt) days.add(String(entry.doneAt).slice(0, 10));
  }
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // 周一为一周之首：getDay() 周日=0，转成周一=0
  const mondayOffset = (base.getDay() + 6) % 7;
  base.setDate(base.getDate() - mondayOffset);
  return labels.map((label, i) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const day = localDay(d);
    return { day, done: days.has(day), label };
  });
}

export interface TodayRef {
  key: string;
  title: string;
  venue: string;
  hasNote: boolean;
}

/**
 * 选今天精读的论文：优先「有笔记且未完成、未忽略、未读」中 dateRead 最早的一篇；
 * 否则退到评分最高的、没有笔记的未读论文。与 macOS 版 ComputeToday 同口径。
 */
export function computeToday(
  notes: Array<{ id: string; key: string; title: string; venue: string; dateRead: string }>,
  ranked: Array<{ key: string; title: string; venue: string }>,
  state: (key: string) => LibraryState,
  progress: ProgressMap,
): TodayRef | null {
  const unfinished = notes
    .filter((n) => !(progress[n.key]?.doneAt ?? '') && !['ignored', 'read', 'deleted'].includes(state(n.key).status))
    .sort((a, b) => (a.dateRead < b.dateRead ? -1 : a.dateRead > b.dateRead ? 1 : 0));
  if (unfinished.length) {
    const n = unfinished[0];
    return { key: n.key, title: n.title, venue: n.venue, hasNote: true };
  }
  const q = ranked.find((r) => !['read', 'deleted'].includes(state(r.key).status));
  if (q) return { key: q.key, title: q.title, venue: q.venue, hasNote: false };
  return null;
}

/** 匹配某主题：标题+摘要里出现该主题的任一关键词。 */
export function topicMatches(paper: QueueEntry, topic: string): boolean {
  const text = ((paper.title ?? '') + ' ' + (paper.abstract ?? '')).toLowerCase();
  const kws = PROFILE_KEYWORDS[topic] ?? [topic.toLowerCase()];
  return kws.some((k) => text.includes(k));
}

/** 关注主题（权重 > 0），按权重降序、同权重按名称升序。与 macOS 版 TopicNavigation.topics 一致。 */
export function followedTopics(topics: Record<string, number>): string[] {
  return Object.keys(topics)
    .filter((t) => (topics[t] ?? 0) > 0)
    .sort((a, b) => ((topics[a] ?? 0) === (topics[b] ?? 0) ? (a < b ? -1 : a > b ? 1 : 0) : (topics[b] ?? 0) - (topics[a] ?? 0)));
}

export const EXPLORATION_TOPIC = '领域探索';

/**
 * 主题流分组：每篇归入权重最高的匹配主题，都不匹配的进「领域探索」。
 * topics 需按权重从高到低传入；空组不返回。与 macOS 版 TopicNavigation.grouped 一致。
 */
export function groupByTopic<T extends { paper: QueueEntry }>(
  ranked: T[], topics: string[],
): Array<[string, T[]]> {
  const groups: Array<[string, T[]]> = topics.map((t) => [t, []]);
  const rest: T[] = [];
  for (const r of ranked) {
    const ix = groups.findIndex(([t]) => topicMatches(r.paper, t));
    if (ix >= 0) groups[ix][1].push(r);
    else rest.push(r);
  }
  if (rest.length) groups.push([EXPLORATION_TOPIC, rest]);
  return groups.filter(([, items]) => items.length > 0);
}
