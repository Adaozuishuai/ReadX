import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type Target = RefObject<HTMLElement | null> | (() => HTMLElement | null);

/** Shared native fullscreen lifecycle for workspaces, including navigation cleanup. */
export function useFullscreen(target: Target) {
  const targetRef = useRef(target);
  targetRef.current = target;
  const entered = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const resolve = useCallback(() => typeof targetRef.current === 'function' ? targetRef.current() : targetRef.current.current, []);
  useEffect(() => {
    const changed = () => setIsFullscreen(Boolean(document.fullscreenElement && document.fullscreenElement === resolve()));
    document.addEventListener('fullscreenchange', changed);
    changed();
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (entered.current && document.fullscreenElement === entered.current) void document.exitFullscreen().catch(() => undefined);
    };
  }, [resolve]);
  const enterFullscreen = useCallback(async () => {
    const element = resolve();
    if (!element?.requestFullscreen) return false;
    try {
      await element.requestFullscreen();
      entered.current = element;
      return document.fullscreenElement === element;
    } catch { return false; }
  }, [resolve]);
  const exitFullscreen = useCallback(async () => {
    if (document.fullscreenElement === resolve()) await document.exitFullscreen().catch(() => undefined);
  }, [resolve]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === resolve()) void exitFullscreen();
    else void enterFullscreen();
  }, [resolve, enterFullscreen, exitFullscreen]);
  return { isFullscreen, enterFullscreen, exitFullscreen, toggleFullscreen };
}
