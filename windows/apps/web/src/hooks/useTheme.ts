import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../lib/storage';

export type ThemeChoice = 'light' | 'dark' | 'paper' | 'system';

const STORAGE_KEY = STORAGE_KEYS.theme;
const CHOICES: ThemeChoice[] = ['light', 'dark', 'paper', 'system'];

function read(): ThemeChoice {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 三主题 + 跟随系统。偏好存本地（与旧版一致，不写服务端），
 * 实际生效的主题写在 <html data-theme>，CSS 变量据此切换。
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setSystemDark(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const update = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍生效，不报错打断。 */
    }
  }, []);

  return { choice, resolved, setTheme: update };
}
