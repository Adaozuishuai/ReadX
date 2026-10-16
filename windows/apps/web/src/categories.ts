/**
 * 彩色分类的展示色。
 *
 * 与批注同一套暖色调色板：整个应用只有一份颜色语义，用户不必学两套「哪个颜色代表什么」。
 * 服务端白名单校验这些值，这里只负责把它们翻成可见的圆点色。
 */

export const CATEGORY_COLORS = ['amber', 'rose', 'sky', 'green', 'violet', 'slate'] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export const CATEGORY_COLOR_LABEL: Record<string, string> = {
  amber: '琥珀',
  rose: '玫红',
  sky: '天蓝',
  green: '青绿',
  violet: '紫罗兰',
  slate: '石板灰',
};

export const CATEGORY_COLOR_DOT: Record<string, string> = {
  amber: '#d99a2b',
  rose: '#e0756b',
  sky: '#5b9fe8',
  green: '#5aa877',
  violet: '#9b7fd4',
  slate: '#8a8175',
};

export function categoryDot(color: string): string {
  return CATEGORY_COLOR_DOT[color] ?? '#8a8175';
}

export function categoryLabel(color: string): string {
  return CATEGORY_COLOR_LABEL[color] ?? color;
}
