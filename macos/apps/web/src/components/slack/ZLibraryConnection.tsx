import { useEffect, useState, type FormEvent } from 'react';
import { zLibraryConnection, type ZLibraryStatus } from '../../api/bookSources';

/** Credentials are posted once to the local backend and cleared from the form. */
export function ZLibraryConnection({ onChange, refreshKey = 0 }: { onChange: () => void; refreshKey?: number }) {
  const [status, setStatus] = useState<ZLibraryStatus | null>(null);
  const [origin, setOrigin] = useState('');
  const [downloadOrigins, setDownloadOrigins] = useState('');
  const [mode, setMode] = useState<'password' | 'session'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [userId, setUserId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const accept = (value: ZLibraryStatus) => {
    setStatus(value); setOrigin(value.origin); setDownloadOrigins(value.downloadOrigins.join('\n')); setMessage(value.message);
  };
  useEffect(() => {
    const controller = new AbortController();
    void zLibraryConnection.status(controller.signal).then(accept).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取连接状态失败'); });
    return () => controller.abort();
  }, [refreshKey]);
  const saveIfChanged = async () => {
    const origins = downloadOrigins.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (origin.trim() !== status?.origin || JSON.stringify(origins) !== JSON.stringify(status?.downloadOrigins)) {
      const updated = await zLibraryConnection.configure(origin.trim(), origins); accept(updated); onChange();
    }
  };
  const action = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '连接失败，请重试'); }
    finally { setBusy(false); setPassword(''); setUserKey(''); }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      await saveIfChanged();
      const connected = await zLibraryConnection.connect(mode === 'password' ? { email, password } : { userId, userKey });
      accept(connected); onChange();
    });
  };
  return <section className="zlibrary-connection" aria-label="Z-Library 连接设置">
    <header><strong>Z-Library · 非官方 EAPI</strong><span>{status?.connected ? '已连接' : '未连接账号'}</span></header>
    <label>服务地址<input type="url" aria-label="Z-Library 服务地址" placeholder="https://你的服务地址" value={origin} disabled={busy} onChange={event => setOrigin(event.target.value)} /></label>
    <details><summary>下载源站（可选）</summary><p>文件下载跳转到其他主机时，填写你确认使用的 HTTPS 源站，一行一个。站点密码和 Key 不会发给这些主机。</p><textarea aria-label="Z-Library 下载源站" value={downloadOrigins} disabled={busy} onChange={event => setDownloadOrigins(event.target.value)} placeholder="https://download.example.org" /></details>
    <div className="zlibrary-connection__actions">
      <button type="button" disabled={busy || !origin} onClick={() => void action(async () => { await saveIfChanged(); accept(await zLibraryConnection.probe()); })}>{busy ? '处理中…' : '检查连接'}</button>
      <button type="button" disabled={busy || !origin} onClick={() => void action(async () => { await saveIfChanged(); setMessage('服务地址已保存'); })}>保存地址</button>
    </div>
    {status?.connected ? <div>
      <p>已连接{status.accountName ? `：${status.accountName}` : ''}{status.downloadsToday !== undefined ? ` · 今日已下载 ${status.downloadsToday}` : ''}{status.dailyLimit !== undefined ? ` / ${status.dailyLimit}` : ''}</p>
      <button type="button" disabled={busy} onClick={() => void action(async () => { accept(await zLibraryConnection.disconnect()); onChange(); })}>断开账号</button>
    </div> : <form onSubmit={connect} autoComplete="off">
      <label>连接方式<select aria-label="Z-Library 连接方式" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as 'password' | 'session'); setPassword(''); setUserKey(''); }}><option value="password">邮箱与密码</option><option value="session">自己的会话 ID 与 Key</option></select></label>
      {mode === 'password' ? <>
        <label>邮箱<input type="email" aria-label="Z-Library 邮箱" autoComplete="off" value={email} disabled={busy} required onChange={event => setEmail(event.target.value)} /></label>
        <label>密码<input type="password" aria-label="Z-Library 密码" autoComplete="off" value={password} disabled={busy} required onChange={event => setPassword(event.target.value)} /></label>
      </> : <>
        <label>会话 ID<input aria-label="Z-Library 会话 ID" autoComplete="off" inputMode="numeric" value={userId} disabled={busy} required onChange={event => setUserId(event.target.value)} /></label>
        <label>会话 Key<input type="password" aria-label="Z-Library 会话 Key" autoComplete="off" value={userKey} disabled={busy} required onChange={event => setUserKey(event.target.value)} /></label>
      </>}
      <button type="submit" className="slack-primary" disabled={busy || !status}>{busy ? '连接中…' : '连接账号'}</button>
    </form>}
    {message && <p role="status">{message}</p>}
    {error && <p className="slack-finder__error" role="alert">{error}</p>}
    <small>会话仅在本次服务运行期间保留；重启后需要重新连接。密码不保存。</small>
  </section>;
}
