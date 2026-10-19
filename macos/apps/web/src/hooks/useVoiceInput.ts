import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechResult { isFinal: boolean; 0: { transcript: string } }
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
function speechConstructor() {
  const browser = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

/** Dictation fills a draft; it never sends a message or starts a voice call. */
export function useVoiceInput(session: string, setText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<Recognition | null>(null);
  const supported = !!speechConstructor();
  const stop = useCallback(() => {
    const recognition = active.current;
    active.current = null;
    if (recognition) { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; try { recognition.abort(); } catch { /* The browser may have already ended this session. */ } }
    setListening(false);
  }, []);
  useEffect(() => { setError(''); return stop; }, [session, stop]);
  const toggle = (draft: string, continuous = false) => {
    if (active.current) { stop(); return; }
    const Speech = speechConstructor();
    if (!Speech) return;
    setError('');
    const recognition = new Speech();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = continuous;
    const prefix = draft ? draft + (/\s$/.test(draft) ? '' : ' ') : '';
    recognition.onresult = (event) => {
      if (active.current !== recognition) return;
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join('');
      setText(prefix + transcript);
    };
    recognition.onerror = (event) => {
      if (active.current !== recognition) return;
      const messages: Record<string, string> = { 'not-allowed': '未获得麦克风权限', 'service-not-allowed': '当前浏览器无法使用语音输入', 'audio-capture': '未找到可用的麦克风', network: '语音输入服务连接失败', 'no-speech': '没有听到声音，请重试' };
      setError(messages[event.error] || '语音输入已中断');
      stop();
    };
    recognition.onend = () => { if (active.current === recognition) { active.current = null; setListening(false); } };
    active.current = recognition;
    try { recognition.start(); setListening(true); }
    catch { stop(); setError('无法启动语音输入'); }
  };
  return { supported, listening, error, toggle, stop };
}
