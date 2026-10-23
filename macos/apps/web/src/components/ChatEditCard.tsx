import type { ChatEditRequest } from '../hooks/useChat';
import { WorkspaceIcon } from './WorkspaceIcon';

export function ChatEditCard({ request, disabled, onApprove, onReject }: {
  request: ChatEditRequest;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { proposal, status, notice } = request;
  const labels = { pending: '等待批准', applying: '正在保存', applied: '已保存', rejected: '已取消' };
  return (
    <section className="chat-edit-card" data-status={status} aria-label="文件修改请求">
      <header>
        <span className="chat-edit-icon"><WorkspaceIcon name={status === 'applied' ? 'check' : 'hand'} size={19} /></span>
        <div><strong>修改文件</strong><code title={proposal.filePath}>{proposal.filePath}</code></div>
        <span className="chat-edit-status">{labels[status]}</span>
      </header>
      <p>{proposal.summary || '按你的要求更新这个文件。'}</p>
      <details className="chat-edit-preview">
        <summary>查看修改内容</summary>
        <div><span>修改前</span><pre>{proposal.original}</pre></div>
        <div><span>修改后</span><pre>{proposal.content}</pre></div>
      </details>
      {notice ? <p className={'chat-edit-notice' + (status === 'pending' ? ' error' : '')} role={status === 'pending' ? 'alert' : 'status'}>{notice}</p> : null}
      {status === 'pending' || status === 'applying' ? (
        <footer>
          <button type="button" disabled={disabled || status === 'applying'} onClick={onReject}>取消修改</button>
          <button type="button" className="primary" disabled={disabled || status === 'applying'} onClick={onApprove}>{status === 'applying' ? '正在保存…' : '确认修改'}</button>
        </footer>
      ) : null}
    </section>
  );
}
