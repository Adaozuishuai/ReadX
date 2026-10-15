import { useEffect, useRef, useState } from 'react';
import { api, type AISettings } from '../api/client';
const providers = [
  { id: 'openai', name: 'OpenAI 兼容 API' },
  { id: 'anthropic', name: 'Anthropic API' },
  { id: 'codex', name: 'Codex CLI' },
  { id: 'claude', name: 'Claude Code CLI' },
  { id: 'kimi', name: 'Kimi Code CLI' },
];
export function AISettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [provider, setProvider] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const cli = ['codex', 'claude', 'kimi'].includes(provider);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void api
      .settings()
      .then((value) => {
        if (active) {
          setSettings(value);
          setProvider(value.provider);
          setBaseURL(value.baseURL);
          setModel(value.model);
        }
      })
      .catch((cause) => {
        if (active) setNotice(String(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async () => {
    setBusy(true);
    setNotice('');
    try {
      const value = await api.saveSettings({
        provider,
        baseURL,
        model,
        apiKey: key,
        clearKey,
      });
      setSettings(value);
      setKey('');
      setClearKey(false);
      setNotice('已保存');
      window.dispatchEvent(new Event('cbct-ai-settings'));
      return true;
    } catch (cause) {
      setNotice(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (!(await save())) return;
    setBusy(true);
    setNotice('正在测试连接…');
    try {
      const result = await api.testAI();
      setNotice(`连接成功：${result.answer.slice(0, 100)}`);
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog className="app-dialog" ref={dialog} onCancel={onClose}>
      <header>
        <h2>AI 设置</h2>
        <button onClick={onClose} aria-label="关闭 AI 设置">
          ×
        </button>
      </header>
      <label>
        接入方式
        <select
          value={provider}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            setProvider(next);
            setClearKey(false);
            setNotice('');
            setBaseURL(
              next === 'anthropic'
                ? 'https://api.anthropic.com/v1'
                : next === 'openai'
                  ? 'https://api.openai.com/v1'
                  : '',
            );
            setModel('');
            setKey('');
          }}
        >
          {providers.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {cli ? (
        <p>
          {settings?.cli[provider]
            ? '已检测到 CLI。请在终端完成登录后点击测试。'
            : '未检测到 CLI，请安装后重新打开设置。'}{' '}
          {provider} {provider === 'claude' ? 'auth login' : 'login'}
          <br />
          <small>
            使用 CLI 已登录的账户；调用在临时目录中进行，关闭文档工具访问。
          </small>
        </p>
      ) : (
        <>
          <label>
            API 地址
            <input
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              disabled={busy}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy}
              placeholder={
                settings?.keyConfigured
                  ? '已保存 Key；留空保留当前地址的 Key'
                  : '输入 API Key'
              }
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(event) => setClearKey(event.target.checked)}
            />
            清除当前地址保存的 Key
          </label>
        </>
      )}
      <label>
        模型
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
          placeholder={
            cli
              ? '留空使用 CLI 默认模型'
              : provider === 'anthropic'
                ? '例如 claude-sonnet-4-5'
                : '填写服务支持的模型名'
          }
        />
      </label>
      <p className="text-xs text-ink-faint">
        提问、翻译和精读生成使用所选渠道。调用时相关文档内容会发送给对应服务。
      </p>
      {notice && <p role="status">{notice}</p>}
      <footer>
        <button onClick={() => void save()} disabled={busy || !settings}>
          保存
        </button>
        <button onClick={() => void test()} disabled={busy || !settings}>
          保存并测试连接
        </button>
      </footer>
    </dialog>
  );
}
