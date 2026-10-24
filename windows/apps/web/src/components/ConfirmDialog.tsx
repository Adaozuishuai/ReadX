import { useCallback, useRef, useState } from 'react';
import { AppDialog } from './AppDialog';

/**
 * 取代原生 window.confirm 的应用内确认对话框（LaTeX 区原先 3 处直接用
 * window.confirm，与全局视觉分裂）。
 *
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm('删除 ${name}？'))) return;
 *   ...继续执行
 * 组件树里渲染一次 <ConfirmDialog bridge={bridge} />（或用下方 ConfirmHost）。
 */
export interface ConfirmBridge {
  confirm: (message: string, options?: { confirmText?: string; cancelText?: string; dangerous?: boolean }) => Promise<boolean>;
}

export function useConfirm(): { bridge: ConfirmBridge; node: React.ReactNode } {
  const [state, setState] = useState<{
    message: string;
    confirmText: string;
    cancelText: string;
    dangerous: boolean;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const confirm = useCallback<ConfirmBridge['confirm']>((message, options) => {
    return new Promise<boolean>((resolve) => {
      if (stateRef.current) {
        stateRef.current.resolve(false); // 上一条未决确认直接按取消结算
      }
      setState({
        message,
        confirmText: options?.confirmText ?? '确定',
        cancelText: options?.cancelText ?? '取消',
        dangerous: options?.dangerous ?? true,
        resolve,
      });
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setState((current) => {
      current?.resolve(ok);
      return null;
    });
  }, []);

  const node = state ? (
    <AppDialog open onClose={() => settle(false)}>
      <p className="confirm-dialog-message">{state.message}</p>
      <div className="confirm-dialog-actions">
        <button type="button" className="confirm-dialog-cancel" onClick={() => settle(false)}>
          {state.cancelText}
        </button>
        <button
          type="button"
          className={state.dangerous ? 'confirm-dialog-danger' : 'confirm-dialog-primary'}
          onClick={() => settle(true)}
        >
          {state.confirmText}
        </button>
      </div>
    </AppDialog>
  ) : null;

  return { bridge: { confirm }, node };
}
