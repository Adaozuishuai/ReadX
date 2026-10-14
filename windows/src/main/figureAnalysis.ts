// 架构图视觉解析（网络与编排）——移植自 macOS FigureAnalysis 的 Store 侧。
//
// 链路：在页面文本里定位图题与图块 → 渲染该页为图 → 视觉模型输出模块与连接的 JSON
// → 用图内 OCR 校验标签 → 校验通过才可用于渲染。
//
// 依赖 Windows 内置 OCR（winOcr）做大图内文字核对；任一步失败只保留图题，不推测结构。

import { FigureAnalysis, decodeFigureAnalysis, validateFigureAnalysis, figureUsable } from '../core/figureAnalysis';
import { ocrImage } from './winOcr';
import { readCachedPDFText } from '../core/store';
import { Config } from '../core/types';

/** 图题启发式：在页文本里找 `Fig./Figure N` 开头的行，返回页码与图题。 */
export function locateFigure(text: string): { page: number; title: string } | null {
  const pages = text.split(/=== Page (\d+) ===/);
  // split 结果：[前置, 页码1, 正文1, 页码2, 正文2, ...]
  for (let i = 1; i < pages.length; i += 2) {
    const pageNo = Number(pages[i]);
    const body = pages[i + 1] ?? '';
    const lines = body.split('\n');
    for (let j = 0; j < lines.length; j++) {
      if (/^\s*(fig\.?|figure)\s*\d+/i.test(lines[j])) {
        const title = lines.slice(j, Math.min(lines.length, j + 4)).join(' ').replace(/\s+/g, ' ').trim();
        return { page: pageNo, title: title.slice(0, 200) };
      }
    }
  }
  return null;
}

const FIGURE_PROMPT = `这是论文中一张模型结构图 / 架构图的截图。请识别图中的模块与它们之间的连接，输出 JSON：
{"page":页码或0,"title":"图题","nodes":[{"id":"唯一短id","label":"图中出现的模块名（必须与图中文字一致）","kind":"input|module|loss|output|data","layer":0}],"edges":[{"from":"id","to":"id","label":"连线上的文字或null"}]}。
硬要求：label 必须是图中**真实可见**的文字（不要改写、不要用同义词、不要补全缩写）；看不见或不确定的模块不要输出；edges 只能引用已列出的 id；不要猜测结构。图中没有可识别的模块时输出 {"page":0,"title":"","nodes":[],"edges":[]}。只输出 JSON。`;

/** 视觉模型解析图结构（OpenAI 兼容 image_url 输入）。 */
async function visionFigure(cfg: Config, dataURL: string, prompt = FIGURE_PROMPT): Promise<{ ok: boolean; text?: string; error?: string }> {
  const hasKey = !!(cfg.apiKey && cfg.apiKey.length && !cfg.apiKey.includes('在这里填入'));
  if (!hasKey || !cfg.baseURL) return { ok: false, error: '尚未配置 API Key，图像解析不可用。' };
  const base = cfg.baseURL.endsWith('/') ? cfg.baseURL.slice(0, -1) : cfg.baseURL;
  let url: URL;
  try { url = new URL(base + '/chat/completions'); } catch { return { ok: false, error: 'API 地址无效。' }; }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return { ok: false, error: 'API 地址无效。' };
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataURL)) return { ok: false, error: '图像数据格式无效。' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model ?? 'glm-4.6', temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataURL } }] }],
      }),
      signal: ac.signal,
    });
    if (!resp.ok) return { ok: false, error: `接口返回 ${resp.status}：配置的模型可能不支持视觉输入。` };
    const body = await resp.json() as any;
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '图像解析没有返回内容。' };
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? '图像解析请求超时。' : `图像解析失败：${msg}` };
  } finally { clearTimeout(timer); }
}

export interface FigureResult { ok: boolean; analysis?: FigureAnalysis; ocrText?: string; page?: number; title?: string; error?: string }

/**
 * 解析一篇论文的架构图。
 * @param pageDataURL 该页的 JPEG dataURL（由渲染层光栅化）
 */
export async function analyzeFigure(paths: any, cfg: Config, key: string, pageDataURL: string): Promise<FigureResult> {
  const text = readCachedPDFText(paths, key) ?? '';
  const located = locateFigure(text);

  // 图内 OCR（本地 Windows OCR）——用于核对模型给出的标签是否真在图中
  const ocr = await ocrImage(pageDataURL);
  if (!ocr.ok) return { ok: false, error: '图内文字 OCR 失败，无法核验标签：' + ocr.error };

  const res = await visionFigure(cfg, pageDataURL);
  if (!res.ok) return { ok: false, page: located?.page, title: located?.title, error: res.error };

  let analysis: FigureAnalysis;
  try { analysis = decodeFigureAnalysis(res.text as string); }
  catch (e) { return { ok: false, page: located?.page, title: located?.title, error: e instanceof Error ? e.message : String(e) }; }

  // 用图内 OCR 校验标签；再要求至少 2 节点 + 1 条边才可用于渲染
  const validated = validateFigureAnalysis(analysis, ocr.text ?? '');
  if (located) { validated.page = located.page; if (!validated.title) validated.title = located.title; }
  if (!figureUsable(validated)) {
    return { ok: false, page: validated.page, title: validated.title, ocrText: ocr.text, error: '图内未识别出可核验的模块结构（可能不是结构图，或图中文字不可读）。' };
  }
  return { ok: true, analysis: validated, ocrText: ocr.text, page: validated.page, title: validated.title };
}
