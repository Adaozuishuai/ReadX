import type { LauncherWorkspace } from '@cbct/shared';

export const WHEEL_SIZE = 720;
export const PROJECTS_PER_PAGE = 8;
export const PROJECT_INNER_RADIUS = 173;
export const PROJECT_OUTER_RADIUS = 273;
export const WHEEL_WORKSPACES: { id: LauncherWorkspace; label: string; icon: 'library' | 'graduation' | 'panel' | 'code' | 'play'; color: string; logoColor: string }[] = [
  { id: 'library', label: '个人书库', icon: 'library', color: '#376b58', logoColor: '#0b5d34' },
  { id: 'research', label: '学术工作台', icon: 'graduation', color: '#82713e', logoColor: '#895006' },
  { id: 'presentation', label: 'PPT', icon: 'panel', color: '#a3644f', logoColor: '#9b1c31' },
  { id: 'latex', label: 'LaTeX Studio', icon: 'code', color: '#646794', logoColor: '#5420a3' },
  { id: 'slack', label: '摸鱼', icon: 'play', color: '#397b89', logoColor: '#084e93' },
];
export function wheelPoint(angle: number, radius: number) {
  const radians = angle * Math.PI / 180;
  return { x: WHEEL_SIZE / 2 + Math.cos(radians) * radius, y: WHEEL_SIZE / 2 + Math.sin(radians) * radius };
}
export function wheelSector(index: number) {
  const start = -126 + index * 72 + 1.2;
  const end = start + 69.6;
  const a = wheelPoint(start, 165), b = wheelPoint(end, 165);
  const c = wheelPoint(end, 79), d = wheelPoint(start, 79);
  return `M ${a.x} ${a.y} A 165 165 0 0 1 ${b.x} ${b.y} L ${c.x} ${c.y} A 79 79 0 0 0 ${d.x} ${d.y} Z`;
}
export function innerWorkspaceAt(x: number, y: number): LauncherWorkspace | null {
  const dx = x - 360, dy = y - 360;
  const radius = Math.hypot(dx, dy);
  if (radius < 79 || radius > 165) return null;
  const angle = ((Math.atan2(dy, dx) * 180 / Math.PI + 126) % 360 + 360) % 360;
  return WHEEL_WORKSPACES[Math.floor(angle / 72)]?.id ?? null;
}
export function projectSlotAt(x: number, y: number, count: number): number | null {
  if (!count) return null;
  const radius = Math.hypot(x - 360, y - 360);
  if (radius < PROJECT_INNER_RADIUS || radius > PROJECT_OUTER_RADIUS) return null;
  const step = 360 / Math.min(count, PROJECTS_PER_PAGE);
  const angle = ((Math.atan2(y - 360, x - 360) * 180 / Math.PI + 90 + step / 2) % 360 + 360) % 360;
  return Math.floor(angle / step);
}

export function projectPlacement(index: number, count: number) {
  const angle = -90 + index * 360 / Math.min(count, PROJECTS_PER_PAGE);
  let rotation = angle + 90;
  if (rotation > 90 && rotation < 270) rotation -= 180;
  else if (rotation >= 270) rotation -= 360;
  return { ...wheelPoint(angle, (PROJECT_INNER_RADIUS + PROJECT_OUTER_RADIUS) / 2), rotation };
}

export function projectSector(index: number, count: number) {
  const step = 360 / Math.min(count, PROJECTS_PER_PAGE);
  const start = -90 + index * step - step / 2 + 0.6;
  const end = start + step - 1.2;
  const a = wheelPoint(start, PROJECT_OUTER_RADIUS), b = wheelPoint(end, PROJECT_OUTER_RADIUS);
  const c = wheelPoint(end, PROJECT_INNER_RADIUS), d = wheelPoint(start, PROJECT_INNER_RADIUS);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${PROJECT_OUTER_RADIUS} ${PROJECT_OUTER_RADIUS} 0 ${largeArc} 1 ${b.x} ${b.y} L ${c.x} ${c.y} A ${PROJECT_INNER_RADIUS} ${PROJECT_INNER_RADIUS} 0 ${largeArc} 0 ${d.x} ${d.y} Z`;
}
