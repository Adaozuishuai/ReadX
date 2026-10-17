import { useEffect, useRef, useState } from 'react';
import { api, type AISettings } from '../api/client';
import { ProviderLogo } from './providerLogos';

/**
 * 服务商预设：点一下即填好「渠道 + 地址 + 建议模型」，仍然只落一份配置。
 *
 * 关键映射：DeepSeek / Kimi / 通义 / GLM / 硅基流动 / 火山方舟 / OpenRouter / Ollama /
 * LM Studio 在本应用里都是「OpenAI 兼容」渠道，差异只在服务地址与建议模型；Anthropic 与
 * 三个 CLI 渠道才是真正的另一种接入方式。logo 指向 providerLogos 里的品牌标识。
 */
interface ProviderPreset {
  id: string;
  name: string;
  kind: 'openai' | 'anthropic' | 'codex' | 'claude' | 'kimi';
  baseURL?: string;
  model?: string;
  local?: boolean;
  logo?: string;
}

const PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'kimi', name: 'Kimi', kind: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', name: '通义千问', kind: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'glm', name: '智谱 GLM', kind: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai', baseURL: 'https://api.siliconflow.cn/v1' },
  { id: 'volcengine', name: '火山方舟', kind: 'openai', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', name: '本机 Ollama', kind: 'openai', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', local: true },
  { id: 'lmstudio', name: '本机 LM Studio', kind: 'openai', baseURL: 'http://127.0.0.1:1234/v1', local: true },
  { id: 'codex', name: 'Codex CLI', kind: 'codex', logo: 'openai' },
  { id: 'claude-cli', name: 'Claude Code CLI', kind: 'claude', logo: 'claude' },
  { id: 'kimi-cli', name: 'Kimi Code CLI', kind: 'kimi', logo: 'kimi' },
];

/** 用「渠道 + 地址」反推当前是哪家预设，供标题与徽标显示。 */
function presetOf(provider: string, baseURL: string): ProviderPreset | undefined {
  const normalized = baseURL.trim().replace(/\/+$/, '').toLowerCase();
  return PRESETS.find((item) => {
    if (item.kind !== provider) return false;
    if (!item.baseURL) return !normalized;
    return item.baseURL.replace(/\/+$/, '').toLowerCase() === normalized;
  });
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

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
  const [test, setTest] = useState<{ state: TestState; detail: string }>({ state: 'idle', detail: '' });
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const modelBox = useRef<HTMLDivElement>(null);
  const filteredModels = modelQuery.trim()
    ? models.filter((item) => item.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    : models;

  // 点面板外部或按 Esc 收起：自绘下拉必须自己管关闭，否则会一直浮在卡片上。
  useEffect(() => {
    if (!modelOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!modelBox.current?.contains(event.target as Node)) setModelOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modelOpen]);
  const cli = ['codex', 'claude', 'kimi'].includes(provider);
  const active = presetOf(provider, baseURL);

  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    void api
      .settings()
      .then((value) => {
        if (!alive) return;
        setSettings(value);
        setProvider(value.provider);
        setBaseURL(value.baseURL);
        setModel(value.model);
      })
      .catch((cause) => {
        if (alive) setNotice(String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const pick = (preset: ProviderPreset) => {
    setProvider(preset.kind);
    setClearKey(false);
    setNotice('');
    setTest({ state: 'idle', detail: '' });
    setKey('');
    setBaseURL(preset.baseURL ?? '');
    setModel(preset.model ?? '');
  };

  const save = async () => {
    setBusy(true);
    setNotice('');
    try {
      const value = await api.saveSettings({ provider, baseURL, model, apiKey: key, clearKey });
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

  // 与参考实现一致：测试前先把当前输入（含 Key）保存，测完给出明确状态而不是只丢一行文字。
  const runTest = async () => {
    if (!(await save())) {
      setTest({ state: 'fail', detail: '保存失败，请先修正上方提示' });
      return;
    }
    setTest({ state: 'testing', detail: '' });
    setNotice('');
    try {
      const result = await api.testAI();
      setTest({ state: 'ok', detail: result.answer.slice(0, 120) });
    } catch (cause) {
      setTest({ state: 'fail', detail: String(cause) });
    }
  };

  // 获取当前地址的模型列表：用刚输入的 Key（未保存也能先看），服务端会回落到该地址已保存的 Key。
  const loadModels = async () => {
    setLoadingModels(true);
    setModelError('');
    try {
      const result = await api.listModels({ provider, baseURL, apiKey: key });
      setModels(result.models);
      if (!result.models.length) setModelError('该地址没有返回任何模型，请确认地址与权限。');
      else if (!model.trim()) setModel(result.models[0] ?? '');
    } catch (cause) {
      setModels([]);
      setModelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <dialog className="app-dialog ai-settings" ref={dialog} onCancel={onClose}>
      <header className="ai-settings-head">
        <button type="button" className="ai-back" onClick={onClose} aria-label="关闭 AI 助手设置">
          ←
        </button>
        <h2>AI 助手设置</h2>
        <span className="ai-count" aria-label="已保存的服务商数量">
          {settings?.status.configured ? 1 : 0}
        </span>
        <span className={`ai-chip${settings?.status.configured ? ' ok' : ''}`}>
          {settings?.status.configured ? '使用中' : '未配置'}
        </span>
      </header>

      <div className="ai-settings-body">
        <div className="ai-service-row">
          <span className="ai-service-badge">
            <ProviderLogo id={active?.logo ?? active?.id ?? (cli ? provider : 'openai')} size={18} />
          </span>
          <div className="min-w-0">
            <strong>{active?.name ?? (cli ? provider.toUpperCase() : '自定义服务商')}</strong>
            <small>
              {cli ? `本机 CLI · ${settings?.cli[provider] ? '已检测到' : '未检测到'}` : baseURL || '尚未填写地址'}
              {model ? ` · ${model}` : ''}
            </small>
          </div>
        </div>

        <p className="ai-step">第 1 步 · 连接服务商</p>

        <section className="ai-card">
          <header>
            <span className="ai-card-icon" aria-hidden="true">
              🗄
            </span>
            常用服务商
          </header>
          <div className="ai-presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={busy}
                aria-pressed={preset.id === active?.id && provider === preset.kind}
                onClick={() => pick(preset)}
                className={`ai-preset${preset.id === active?.id && provider === preset.kind ? ' active' : ''}`}
                title={preset.local ? `${preset.baseURL}（本机服务）` : preset.baseURL ?? '使用本机 CLI 已登录的账户'}
              >
                <ProviderLogo id={preset.logo ?? preset.id} size={15} />
                {preset.name}
              </button>
            ))}
          </div>
        </section>

        {cli ? (
          <section className="ai-card">
            <header>
              <span className="ai-card-icon" aria-hidden="true">
                ⌘
              </span>
              本机 CLI
            </header>
            <p className="ai-hint">
              {settings?.cli[provider] ? '已检测到 CLI。' : '未检测到 CLI，请安装后重新打开设置。'}
              请先在终端执行 <code>{provider} {provider === 'claude' ? 'auth login' : 'login'}</code>。
              程序使用 CLI 已登录的账户，调用在临时目录中进行，并关闭文档工具访问。
            </p>
          </section>
        ) : (
          <>
            <section className="ai-card">
              <header>
                <span className="ai-card-icon" aria-hidden="true">
                  🔗
                </span>
                服务地址
              </header>
              <input
                value={baseURL}
                disabled={busy}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://api.example.invalid/v1"
                aria-label="服务地址"
              />
              <p className="ai-hint">
                {provider === 'anthropic'
                  ? 'Anthropic Messages API 地址，通常以 /v1 结尾。'
                  : 'OpenAI 兼容地址，通常以 /v1 结尾；本机模型填回环地址。'}
              </p>
            </section>

            <section className="ai-card">
              <header>
                <span className="ai-card-icon" aria-hidden="true">
                  🔑
                </span>
                API Key
              </header>
              <input
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={busy}
                onChange={(event) => setKey(event.target.value)}
                placeholder={settings?.keyConfigured ? '已保存 Key；留空保留当前地址的 Key' : '填写服务商提供的密钥'}
                aria-label="API Key"
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(event) => setClearKey(event.target.checked)}
                  disabled={busy}
                />
                清除当前地址保存的 Key
              </label>
            </section>
          </>
        )}

        <section className="ai-card">
          <header>
            <span className="ai-card-icon" aria-hidden="true">
              🧭
            </span>
            模型
          </header>
          <div className="ai-model-row" ref={modelBox}>
            <input
              value={model}
              disabled={busy}
              onChange={(event) => setModel(event.target.value)}
              onFocus={() => setModelOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setModelOpen(false);
              }}
              placeholder={
                cli ? '留空使用 CLI 默认模型' : provider === 'anthropic' ? '例如 claude-sonnet-4-5' : '填写服务支持的模型名'
              }
              aria-label="模型"
              aria-expanded={modelOpen}
            />
            <button
              type="button"
              className="ai-model-button"
              disabled={busy || cli || loadingModels}
              onClick={() => void loadModels()}
              title={cli ? 'CLI 渠道使用它自己的默认模型' : '读取当前地址 /models 与 /model/info 返回的可用模型'}
            >
              {loadingModels ? '获取中…' : '获取模型列表'}
            </button>
            {models.length ? (
              <button
                type="button"
                className="ai-model-caret"
                onClick={() => setModelOpen((value) => !value)}
                aria-label="展开模型列表"
                aria-expanded={modelOpen}
                title={`共 ${models.length} 个模型`}
              >
                ⌄
              </button>
            ) : null}
            {/*
              原生 <datalist> 的下拉在 Chromium 里只显示寥寥几行而且滚不动，
              所以这里自绘：外层限高、内层真正可滚动，并带独立的筛选框。
            */}
            {modelOpen && models.length ? (
              <div className="ai-model-menu">
                <input
                  className="ai-model-search"
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={`筛选 ${models.length} 个模型`}
                  aria-label="筛选模型名"
                  autoFocus
                />
                <div className="ai-model-scroll" role="listbox" aria-label="模型列表">
                  {filteredModels.map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="option"
                      aria-selected={item === model}
                      className={`ai-model-item${item === model ? ' active' : ''}`}
                      onClick={() => {
                        setModel(item);
                        setModelOpen(false);
                        setModelQuery('');
                      }}
                    >
                      {item}
                    </button>
                  ))}
                  {filteredModels.length === 0 ? <p className="ai-model-empty">没有匹配的模型名</p> : null}
                </div>
              </div>
            ) : null}
          </div>
          <p className={modelError ? 'ai-hint ai-hint-bad' : 'ai-hint'}>
            {modelError
              ? modelError
              : models.length
                ? `已获取 ${models.length} 个模型，点输入框右侧箭头或直接输入筛选。`
                : '提问、翻译与精读生成共用这个渠道；不填则用服务端默认值。可先获取模型列表再挑选。'}
          </p>
        </section>

        <section className="ai-card ai-test-card">
          <header>
            <span className="ai-card-icon" aria-hidden="true">
              🔌
            </span>
            测试连接
          </header>
          <div className="ai-test-row">
            <p className="ai-hint">
              请先填写 API Key；测试会使用当前输入的密钥，保存设置后才会加密保存在本机。
            </p>
            <span className={`ai-chip${test.state === 'ok' ? ' ok' : test.state === 'fail' ? ' bad' : ''}`}>
              {test.state === 'testing' ? '正在测试…' : test.state === 'ok' ? '连接可用' : test.state === 'fail' ? '连接失败' : '待测试'}
            </span>
            <button type="button" className="ai-test-button" disabled={busy || !settings} onClick={() => void runTest()}>
              {busy ? '处理中…' : '测试连接'}
            </button>
          </div>
          {test.detail ? <p className={test.state === 'ok' ? 'ai-result ok' : 'ai-result bad'}>{test.detail}</p> : null}
        </section>

        <p className="ai-hint">
          调用时相关文档内容会发送给所选服务；Key 保存在本机 <code>app/config.json</code>，不会回传界面。
        </p>
        {notice ? <p role="status" className="ai-result">{notice}</p> : null}
      </div>

      <footer className="ai-settings-foot">
        <button type="button" className="ai-save-button" disabled={busy || !settings} onClick={() => void save()}>
          保存设置
        </button>
      </footer>
    </dialog>
  );
}
