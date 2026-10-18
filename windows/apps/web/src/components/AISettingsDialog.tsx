import { useEffect, useRef, useState } from 'react';
import { api, type AISettings, type CodexModel, type OCRSettings } from '../api/client';
import { effortLabel } from './AIModelControls';
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
  /**
   * 自定义服务商：不预设地址与模型，由用户自己填。
   * 它的 baseURL 为空，所以 presetOf 必须显式跳过，否则任何自填地址都会被它"认领"。
   */
  custom?: boolean;
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
  { id: 'codex', name: 'Codex Desktop / CLI', kind: 'codex', logo: 'openai' },
  { id: 'claude-cli', name: 'Claude Code CLI', kind: 'claude', logo: 'claude' },
  { id: 'kimi-cli', name: 'Kimi Code CLI', kind: 'kimi', logo: 'kimi' },
  // 自定义放最后：它是个"空模板"，不是某家厂商。
  { id: 'custom', name: '自定义服务商', kind: 'openai', custom: true },
];

/** 用「渠道 + 地址」反推当前是哪家预设，供标题与徽标显示。 */
function presetOf(provider: string, baseURL: string): ProviderPreset | undefined {
  const normalized = baseURL.trim().replace(/\/+$/, '').toLowerCase();
  return PRESETS.find((item) => {
    // 自定义没有固定地址，永远不该被"反推"命中——否则自填的任何地址都会显示成它。
    if (item.custom) return false;
    if (item.kind !== provider) return false;
    if (!item.baseURL) return !normalized;
    return item.baseURL.replace(/\/+$/, '').toLowerCase() === normalized;
  });
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export function AISettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [ocrSettings, setOCRSettings] = useState<OCRSettings | null>(null);
  const [ocrToken, setOCRToken] = useState('');
  const [ocrBaseURL, setOCRBaseURL] = useState('');
  const [ocrModel, setOCRModel] = useState('');
  const [clearOCRToken, setClearOCRToken] = useState(false);
  const [savingOCR, setSavingOCR] = useState(false);
  const [ocrNotice, setOCRNotice] = useState('');
  const [provider, setProvider] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [translationPreparation, setTranslationPreparation] = useState<'off' | 'artifacts_only' | 'terms' | 'terms+style' | 'editorial'>('off');
  const [catalog, setCatalog] = useState<CodexModel[]>([]);
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
  const modelRequest = useRef(0);
  const saveLock = useRef(false);
  const testLock = useRef(false);
  /**
   * 是否处于「自定义服务商」。
   *
   * presetOf 是靠地址反推的，而自定义没有固定地址，所以它推不出来——
   * 必须单独记一个标记，否则点了自定义之后按钮不会亮、标题也会显示成别家。
   */
  const [customMode, setCustomMode] = useState(false);
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
  /** 界面统一用这个判断"当前是哪家"：自定义优先，否则靠地址反推。 */
  const activeId = customMode ? 'custom' : active?.id;
  /**
   * 标题：认识的服务商显示名字；不认识的地址**显示地址本身**，
   * 而不是硬套一个"自定义服务商"——后者会让人以为配置被改了。
   */
  const activeName = customMode ? '自定义服务商' : (active?.name ?? (cli ? provider.toUpperCase() : null));

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
        setReasoningEffort(value.reasoningEffort ?? '');
        setTranslationPreparation(value.translationPreparation === 'editorial' ? 'editorial' : value.translationPreparation === 'terms+style' ? 'terms+style' : value.translationPreparation === 'terms' ? 'terms' : value.translationPreparation === 'artifacts_only' ? 'artifacts_only' : 'off');
        /*
         * 刻意不靠"地址对不上预设"来推断自定义。
         * 任何 OpenAI 兼容地址都是合法配置（例如网关 https://api.llm.ustc.edu.cn，
         * 它不带 /v1，本来就不该匹配 deepseek 等预设），把它标成"自定义服务商"
         * 是在对用户的意图瞎猜，还会让内置服务商看起来被换掉了。
         * 只有用户自己点了自定义、并且还没保存过时，才算自定义态。
         */
        setCustomMode(false);
      })
      .catch((cause) => {
        if (alive) setNotice(String(cause));
      });
    void api.ocrSettings().then((value) => {
      if (!alive) return;
      setOCRSettings(value);
      setOCRBaseURL(value.baseURL);
      setOCRModel(value.model);
    }).catch((cause) => {
      if (alive) setOCRNotice(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const sequence = ++modelRequest.current;
    setModels([]); setCatalog([]); setModelError(''); setModelOpen(false);
    setLoadingModels(false);
    if (provider !== 'codex') return;
    let alive = true;
    setLoadingModels(true);
    void api.listModels({ provider: 'codex', baseURL: '' }).then((result) => {
      if (alive && sequence === modelRequest.current) { setModels(result.models); setCatalog(result.catalog ?? []); }
    }).catch((cause) => { if (alive && sequence === modelRequest.current) setModelError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive && sequence === modelRequest.current) setLoadingModels(false); });
    return () => { alive = false; ++modelRequest.current; };
  }, [provider, baseURL]);
  const selectedCodexModel = catalog.find((item) => model ? item.model === model || item.id === model : item.isDefault);

  const pick = (preset: ProviderPreset) => {
    setReasoningEffort('');
    setProvider(preset.kind);
    setCustomMode(Boolean(preset.custom));
    setClearKey(false);
    setNotice('');
    setTest({ state: 'idle', detail: '' });
    setKey('');
    // 自定义保留用户已填的地址与模型：切过去常常是为了改一个字段，
    // 清空会让人白填一遍。其余预设照旧用它的默认值。
    if (!preset.custom) {
      setBaseURL(preset.baseURL ?? '');
      setModel(preset.model ?? '');
    }
  };

  const save = async () => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setBusy(true);
    setNotice('');
    try {
      const value = await api.saveSettings({ provider, baseURL, model, reasoningEffort, translationPreparation, apiKey: key, clearKey });
      setSettings(value);
      setKey('');
      setClearKey(false);
      setNotice('已保存');
      window.dispatchEvent(new CustomEvent('cbct-ai-settings', { detail: { settings: value } }));
      return true;
    } catch (cause) {
      setNotice(String(cause));
      return false;
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  };

  const saveOCR = async () => {
    if (savingOCR) return;
    setSavingOCR(true);
    setOCRNotice('');
    try {
      const value = await api.saveOCRSettings({
        token: ocrToken,
        clearToken: clearOCRToken,
        baseURL: ocrBaseURL,
        model: ocrModel,
      });
      setOCRSettings(value);
      setOCRToken('');
      setClearOCRToken(false);
      setOCRNotice(value.configured ? 'PaddleOCR 设置已保存在本机。' : 'PaddleOCR 令牌已清除。');
      window.dispatchEvent(new CustomEvent('cbct-ocr-settings', { detail: { settings: value } }));
    } catch (cause) {
      setOCRNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingOCR(false);
    }
  };

  // 与参考实现一致：测试前先把当前输入（含 Key）保存，测完给出明确状态而不是只丢一行文字。
  const runTest = async () => {
    if (testLock.current) return;
    testLock.current = true;
    if (!(await save())) {
      testLock.current = false;
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
    } finally {
      testLock.current = false;
    }
  };

  // 获取当前地址的模型列表：用刚输入的 Key（未保存也能先看），服务端会回落到该地址已保存的 Key。
  const loadModels = async () => {
    const sequence = ++modelRequest.current;
    setLoadingModels(true);
    setModelError('');
    try {
      const result = await api.listModels({ provider, baseURL, apiKey: key });
      if (sequence !== modelRequest.current) return;
      setModels(result.models);
      setCatalog(result.catalog ?? []);
      if (!result.models.length) setModelError('该地址没有返回任何模型，请确认地址与权限。');
      else if (!model.trim() && provider !== 'codex') setModel(result.models[0] ?? '');
    } catch (cause) {
      if (sequence !== modelRequest.current) return;
      setModels([]);
      setModelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === modelRequest.current) setLoadingModels(false);
    }
  };

  return (
    <dialog
      className="app-dialog ai-settings"
      ref={dialog}
      onCancel={(event) => {
        // 模型下拉展开时按 Esc 只想收起下拉：原生 dialog 的 cancel 会顺带关掉整个
        // 设置弹窗，把还没保存的地址/Key/模型输入一起丢掉。
        if (modelOpen) {
          event.preventDefault();
          setModelOpen(false);
          return;
        }
        onClose();
      }}
    >
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
            {/* 认识的服务商显示其标识；自定义用中性符号；都不是就别硬套别家 logo。 */}
            <ProviderLogo id={activeId ?? active?.logo ?? (cli ? provider : 'custom')} size={18} />
          </span>
          <div className="min-w-0">
            <strong>{activeName ?? baseURL ?? '尚未填写地址'}</strong>
            <small>
              {provider === 'codex'
                ? `${settings?.codex?.source === 'desktop' ? 'Codex Desktop' : '本机 Codex'} · ${settings?.codex?.authenticated ? '已登录' : settings?.cli.codex ? '待确认登录' : '未检测到'}`
                : cli ? `本机 CLI · ${settings?.cli[provider] ? '已检测到' : '未检测到'}` : baseURL || '尚未填写地址'}
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
            {PRESETS.map((preset) => {
              const on = preset.id === activeId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  onClick={() => pick(preset)}
                  className={`ai-preset${on ? ' active' : ''}${preset.custom ? ' custom' : ''}`}
                  title={
                    preset.custom
                      ? '自己填服务地址与模型（OpenAI 兼容接口）'
                      : preset.local
                        ? `${preset.baseURL}（本机服务）`
                        : preset.id === 'codex' ? '自动识别 Codex Desktop 或 CLI，使用已有登录' : preset.baseURL ?? '使用本机 CLI 已登录的账户'
                  }
                >
                  <ProviderLogo id={preset.custom ? 'custom' : (preset.logo ?? preset.id)} size={15} />
                  {preset.name}
                </button>
              );
            })}
          </div>
        </section>

        {cli ? (
          <section className="ai-card">
            <header>
              <span className="ai-card-icon" aria-hidden="true">
                ⌘
              </span>
              {provider === 'codex' ? '连接 Codex' : '本机 CLI'}
            </header>
            <p className="ai-hint">
              {provider === 'codex' ? (
                <>{settings?.codex?.message ?? '自动查找 Codex Desktop 自带程序或独立 CLI。请先在 Codex Desktop 登录，再重新打开设置。'}
                  {' '}无需另外安装 CLI；连接时使用 Codex 自身的登录凭据。
                </>
              ) : (
                <>{settings?.cli[provider] ? '已检测到 CLI。' : '未检测到 CLI，请安装后重新打开设置。'}
                  请先在终端执行 <code>{provider} {provider === 'claude' ? 'auth login' : 'login'}</code>。
                </>
              )}
              {' '}调用在临时目录中进行，并关闭文档工具访问。
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
                {customMode
                  ? '填你要接的 OpenAI 兼容地址（通常以 /v1 结尾）。模型名按该服务的命名填，可点下面的「获取模型列表」拉取。'
                  : provider === 'anthropic'
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
              onChange={(event) => { setModel(event.target.value); setReasoningEffort(''); }}
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
              disabled={busy || (cli && provider !== 'codex') || loadingModels}
              onClick={() => void loadModels()}
              title={provider === 'codex' ? '读取本机 Codex 模型和推理强度目录' : cli ? 'CLI 渠道使用它自己的默认模型' : '读取当前地址的可用模型'}
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
                        setReasoningEffort('');
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

        {provider === 'codex' && <section className="ai-card"><header>推理强度</header><label className="ai-model-controls"><select aria-label="Codex 推理强度" value={reasoningEffort} disabled={busy || loadingModels || !selectedCodexModel} onChange={(e) => setReasoningEffort(e.target.value)}><option value="">跟随模型默认{selectedCodexModel ? ` · ${effortLabel(selectedCodexModel.defaultReasoningEffort)}` : ''}</option>{reasoningEffort && !selectedCodexModel?.supportedReasoningEfforts.some((e) => e.reasoningEffort === reasoningEffort) && <option value={reasoningEffort}>{reasoningEffort} · 待校验</option>}{selectedCodexModel?.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{effortLabel(option.reasoningEffort)}</option>)}</select></label><p className="ai-hint">选项来自本机 Codex，不同模型支持的等级不同。保存后供后续提问与精读生成使用；更高等级通常需要更长时间。</p></section>}

        <section className="ai-card"><header>译前准备</header><label className="ai-model-controls"><select aria-label="译前准备模式" value={translationPreparation} disabled={busy} onChange={(event) => setTranslationPreparation(event.target.value === 'editorial' ? 'editorial' : event.target.value === 'terms+style' ? 'terms+style' : event.target.value === 'terms' ? 'terms' : event.target.value === 'artifacts_only' ? 'artifacts_only' : 'off')}><option value="off">关闭（RetainPDF 默认）</option><option value="artifacts_only">仅生成术语库与风格指南，不注入</option><option value="terms">术语预扫（terms）</option><option value="terms+style">术语预扫与风格指南（terms+style）</option><option value="editorial">术语预扫、审定与风格指南（editorial）</option></select></label><p className="ai-hint">术语建议仅作为翻译提示，不写入用户术语表。Editorial 会按 RetainPDF 规则审定术语并处理人名、出版物与普通词；风格指南失败时保留通用规则继续翻译。</p></section>

        <section className="ai-card ai-test-card">
          <header>
            <span className="ai-card-icon" aria-hidden="true">
              🔌
            </span>
            测试连接
          </header>
          <div className="ai-test-row">
            <p className="ai-hint">
              {cli ? '使用本机已登录账户和当前模型配置确认连接。' : '测试前会保存当前输入的服务地址、模型与密钥。'}
            </p>
            <span className={`ai-chip${test.state === 'ok' ? ' ok' : test.state === 'fail' ? ' bad' : ''}`}>
              {test.state === 'testing' ? '正在测试…' : test.state === 'ok' ? '连接可用' : test.state === 'fail' ? '连接失败' : '待测试'}
            </span>
            <button type="button" className="ai-test-button" disabled={busy || test.state === 'testing' || !settings} onClick={() => void runTest()}>
              {busy ? '处理中…' : '测试连接'}
            </button>
          </div>
          {test.detail ? <p className={test.state === 'ok' ? 'ai-result ok' : 'ai-result bad'}>{test.detail}</p> : null}
        </section>

        <p className="ai-step">第 2 步 · 文档识别</p>
        <section className="ai-card ai-ocr-card">
          <header>
            <span className="ai-card-icon" aria-hidden="true">▤</span>
            PaddleOCR
            <span className={`ai-chip${ocrSettings?.configured ? ' ok' : ''}`}>
              {ocrSettings?.configured ? '已配置' : ocrSettings ? '未配置' : '读取中'}
            </span>
          </header>
          <label>
            访问令牌
            <input
              type="password"
              autoComplete="new-password"
              value={ocrToken}
              disabled={savingOCR}
              onChange={(event) => { setOCRToken(event.target.value); setClearOCRToken(false); }}
              placeholder={ocrSettings?.configured ? '已保存；留空保持不变' : '填写 PaddleOCR 访问令牌'}
              aria-label="PaddleOCR 访问令牌"
            />
          </label>
          {ocrSettings?.configured ? (
            <label className="checkbox-label">
              <input type="checkbox" checked={clearOCRToken} disabled={savingOCR} onChange={(event) => setClearOCRToken(event.target.checked)} />
              清除已保存的 PaddleOCR 令牌
            </label>
          ) : null}
          <label>
            服务地址
            <input value={ocrBaseURL} disabled={savingOCR} onChange={(event) => setOCRBaseURL(event.target.value)} aria-label="PaddleOCR 服务地址" />
          </label>
          <label>
            模型
            <input value={ocrModel} disabled={savingOCR} onChange={(event) => setOCRModel(event.target.value)} aria-label="PaddleOCR 模型" />
          </label>
          <p className="ai-hint">RetainPDF 会使用此 OCR 服务完成整篇识别。上传上限默认 512 MB，实际页数与文件限制由 OCR 服务决定；令牌仅保存在本机配置中。</p>
          <div className="ai-ocr-actions">
            <button type="button" className="ai-save-button" disabled={savingOCR || !ocrSettings} onClick={() => void saveOCR()}>
              {savingOCR ? '保存中…' : '保存 OCR 设置'}
            </button>
          </div>
          {ocrNotice ? <p role="status" className={`ai-result${ocrSettings?.configured ? ' ok' : ''}`}>{ocrNotice}</p> : null}
        </section>

        <p className="ai-hint">
          调用时相关文档内容会发送给所选服务；AI Key 与 PaddleOCR 令牌保存在本机 <code>app/config.json</code>，不会回传界面。
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
