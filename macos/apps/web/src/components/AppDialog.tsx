import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 应用内模态对话框的共用骨架。
 *
 * 收编原先 9 个文件各自手写的样板：useRef<HTMLDialogElement> + showModal 副作用
 * + 「busy 时拦截 ESC/关闭」的 onCancel。样式沿用 index.css 既有的 .app-dialog。
 */
export interface AppDialogProps {
  /** 由父组件控制：true 时打开，false 时关闭。 */
  open: boolean;
  onClose: () => void;
  /** busy 时阻止 ESC 与遮罩点击关闭（防误关）。布尔或取值函数——ref 型状态
   *（如 pending.current / lock.current）用函数形式，避免闭包过期读到旧值。 */
  busy?: boolean | (() => boolean);
  /** 透传到 dialog 的附加类名（如 "ai-settings"、宽度定制）。 */
  className?: string;
  'aria-labelledby'?: string;
  'aria-busy'?: boolean;
  /** 点击遮罩（dialog 自身）关闭。默认 false：与多数原实现一致，仅 ESC/按钮关闭。 */
  closeOnBackdrop?: boolean;
  /** 覆盖默认的 ESC 处理（AISettings 的下拉收起、ImportDialog 的中止导入等
   * 自定义语义经此透传；未提供时走 busy/onClose 的默认守卫）。 */
  onCancel?: (event: React.SyntheticEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

export function AppDialog({ open, onClose, busy, className, closeOnBackdrop = false, onCancel, children, ...rest }: AppDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const isBusy = () => (typeof busy === 'function' ? busy() : Boolean(busy));
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className ? `app-dialog ${className}` : 'app-dialog'}
      onCancel={(event) => {
        if (onCancel) {
          onCancel(event);
          return;
        }
        event.preventDefault();
        if (!isBusy()) onClose();
      }}
      onClick={(event) => {
        if (closeOnBackdrop && !isBusy() && event.target === ref.current) onClose();
      }}
      {...rest}
    >
      {children}
    </dialog>
  );
}
