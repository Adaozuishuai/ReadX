/**
 * 摸鱼统计：按天记录阅读时长与读完的章/页数。
 * 只存 localStorage（体量极小），只保留最近 90 天；日期一律用本地时区。
 */
import { STORAGE_KEYS, writeJSON } from '../../lib/storage';

export interface SlackStatsDay {
  seconds: number;
  chapters: number;
  pages: number;
}

export type SlackStatsLog = Record<string, SlackStatsDay>;

export interface SlackStatsWeek {
  seconds: number;
  chapters: number;
  pages: number;
  streak: number;
}

const KEEP_DAYS = 90;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

export function loadStats(): SlackStatsLog {
  let parsed: Partial<Record<string, Partial<SlackStatsDay>>> = {};
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.slackStats) ?? '{}') as typeof parsed;
  } catch {
    return {};
  }
  const log: SlackStatsLog = {};
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(parsed)) {
    const date = parseDate(key);
    if (!date || date.getTime() < cutoff) continue;
    log[key] = {
      seconds: Math.max(0, Math.round(Number(value?.seconds) || 0)),
      chapters: Math.max(0, Math.round(Number(value?.chapters) || 0)),
      pages: Math.max(0, Math.round(Number(value?.pages) || 0)),
    };
  }
  return log;
}

function saveStats(log: SlackStatsLog): void {
  writeJSON(STORAGE_KEYS.slackStats, log);
}

function mutate(mutator: (day: SlackStatsDay) => void): void {
  const log = loadStats();
  const key = dayKey(new Date());
  const day = log[key] ?? { seconds: 0, chapters: 0, pages: 0 };
  mutator(day);
  log[key] = day;
  saveStats(log);
}

/** 阅读中每隔一段时间上报一次；只在页面可见时由调用方触发。 */
export function recordReading(seconds: number): void {
  if (seconds <= 0) return;
  mutate((day) => {
    day.seconds += seconds;
  });
}

export function recordChapters(count: number): void {
  if (count <= 0) return;
  mutate((day) => {
    day.chapters += count;
  });
}

export function recordPages(count: number): void {
  if (count <= 0) return;
  mutate((day) => {
    day.pages += count;
  });
}

function active(day: SlackStatsDay | undefined): boolean {
  return Boolean(day && (day.seconds > 0 || day.chapters > 0 || day.pages > 0));
}

/** 最近 7 天合计 + 连续摸鱼天数（今天还没摸就从昨天起算，避免早上清零）。 */
export function weekStats(now = new Date()): SlackStatsWeek {
  const log = loadStats();
  const week: SlackStatsWeek = { seconds: 0, chapters: 0, pages: 0, streak: 0 };
  for (let offset = 0; offset < 7; offset++) {
    const day = log[dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))];
    if (!day) continue;
    week.seconds += day.seconds;
    week.chapters += day.chapters;
    week.pages += day.pages;
  }
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!active(log[dayKey(cursor)])) cursor.setDate(cursor.getDate() - 1);
  while (active(log[dayKey(cursor)])) {
    week.streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return week;
}

export function formatSlackDuration(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? '不到 1 分钟' : '0 分钟';
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}
