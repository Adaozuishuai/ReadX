import { useState, type ReactNode } from 'react';
import type { ReadingEntry } from '../api/client';
import type { ReadingField } from '../hooks/useReadings';
import { LatexFormula, MathText } from './FormulaContent';

const STRUCTURED_LABELS: Record<string, string> = {
  sections: '内容', fields: '要点', k: '字段', v: '内容', page: '页码', excerpt: '原文依据', formulas: '公式',
  visuals: '相关图表', step: '所属步骤', analysis: '图表分析', tables: '结果表', caption: '表题', header: '表头', protocol: '实验协议',
  columns: '指标列', rows: '结果行', method: '方法', cells: '数值', valueText: '数值', uncertaintyText: '误差', label: '指标', metric: '指标名', unit: '单位',
  stability: '稳健性', ablation: '组件或分组分析', generalization: '外部验证与泛化', efficiency: '效率与成本', statistics: '统计报告', missing: '缺失与待核对',
  resources: '代码、数据与材料', environment: '环境与依赖', cost: '资源成本', risks: '风险与评估协议', finding: '论文依据', assessment: '分析', action: '核对行动',
  interpretation: '结果解读', title: '标题', id: '编号', suggestedStep: '建议步骤',
};

export function parseJSONPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  let source = text.trim();
  for (let depth = 0; depth < 3; depth++) {
    if (source.startsWith('```')) source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const value: unknown = JSON.parse(source);
      if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) { source = value; continue; }
      return { ok: true, value };
    } catch { return { ok: false }; }
  }
  return { ok: false };
}

function displayKey(key: string) {
  return STRUCTURED_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function StructuredJSONView({ value, onCite, depth = 0 }: { value: unknown; onCite: (page: number) => void; depth?: number }) {
  if (value == null || value === '') return <span className="text-ink-soft">—</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return <MathText text={String(value)} />;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-ink-soft">无</span>;
    return <div className="space-y-2">{value.map((item, index) => <div key={index} className="rounded-lg border border-line px-2.5 py-2"><StructuredJSONView value={item} onCite={onCite} depth={depth + 1} /></div>)}</div>;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.k === 'string' && typeof record.v === 'string') {
    const field: ReadingField = { k: record.k, v: record.v };
    if (typeof record.page === 'number') field.page = record.page;
    if (typeof record.excerpt === 'string') field.excerpt = record.excerpt;
    return <EvidenceField field={field} onCite={onCite} />;
  }
  return <div className={depth === 0 ? 'space-y-2' : 'space-y-1'}>{Object.entries(record).map(([key, item]) => <div key={key} className={depth === 0 ? 'reading-section' : 'reading-fact'}>
    <strong>{displayKey(key)}</strong><div className="mt-1"><StructuredJSONView value={item} onCite={onCite} depth={depth + 1} /></div>
  </div>)}</div>;
}

function isReadingField(value: unknown): value is ReadingField {
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return typeof field.k === 'string' && typeof field.v === 'string';
}

export function EvidenceField({ field, onCite }: { field: ReadingField; onCite: (page: number) => void }) {
  if (!isReadingField(field)) return <p>此条目格式无法解析，请对照原始记录。</p>;
  return <div className="reading-fact">
    <strong><MathText text={field.k} /></strong><p><MathText text={field.v} /></p>
    {field.page != null && <button className="assistant-citation" onClick={() => onCite(field.page!)}>Page {field.page}</button>}
    {field.excerpt && <details><summary>原文依据</summary><blockquote>{field.excerpt}</blockquote></details>}
  </div>;
}

export function ResearchNotesBlock({ entry, onCite, renderVisuals }: { entry: ReadingEntry; onCite: (page: number) => void; renderVisuals?: (section: string) => ReactNode }) {
  let sections: { title: string; fields: ReadingField[] }[] = [];
  let formulas: { latex: string; explanation: string; page?: number; excerpt?: string }[] = [];
  const payload = parseJSONPayload(entry.value);
  try {
    const raw = (payload.ok ? payload.value : null) as Record<string, unknown> | null;
    if (raw && Array.isArray(raw.sections)) sections = raw.sections.filter((section: { title?: unknown; fields?: unknown[] } | null) => section && typeof section.title === 'string' && Array.isArray(section.fields) && section.fields.every(isReadingField));
    if (raw && Array.isArray(raw.formulas)) formulas = raw.formulas.filter((formula: { latex?: unknown; explanation?: unknown; page?: unknown } | null) => formula && typeof formula.latex === 'string' && typeof formula.explanation === 'string' && (formula.page == null || typeof formula.page === 'number'));
  } catch { /* Legacy prose remains readable. */ }
  if (!sections.length) {
    if (payload.ok) return <StructuredJSONView value={payload.value} onCite={onCite} />;
    const parts = entry.value.split(/(Page\s+\d+)/g);
    return <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{parts.map((text, index) => /^Page\s+\d+$/.test(text) ? <button key={index} className="text-accent" onClick={() => onCite(Number(text.match(/\d+/)![0]))}>{text}</button> : <MathText key={index} text={text} />)}{formulas.map((formula, index) => <div key={`formula-${index}`}><LatexFormula latex={formula.latex} /><p>{formula.explanation}{formula.page != null && <button className="ml-2 text-accent" onClick={() => onCite(formula.page!)}>Page {formula.page}</button>}</p></div>)}</div>;
  }
  return <div>{sections.map((section, index) => <section key={index} className="reading-section"><h3><MathText text={section.title} /></h3>
    {Array.isArray(section.fields) && section.fields.map((field, index) => <EvidenceField key={index} field={field} onCite={onCite} />)}
    {sections.findIndex((item) => item.title === section.title) === index && renderVisuals?.(section.title)}
  </section>)}{formulas.length > 0 && <section className="reading-section"><h3>关键公式 · 符号与适用条件</h3>{formulas.map((formula, index) => <article className="reading-formula" key={index}><LatexFormula latex={formula.latex} /><p><MathText text={formula.explanation} />{formula.page != null && <button className="assistant-citation" onClick={() => onCite(formula.page!)}>Page {formula.page}</button>}</p>{typeof formula.excerpt === 'string' && <details><summary>公式原文依据</summary><blockquote>{formula.excerpt}</blockquote></details>}</article>)}</section>}</div>;
}

interface ResultTable {
  id?: string;
  caption?: ReadingField;
  protocol?: ReadingField;
  columns?: { id: string; label: string; metric?: string; unit?: string; context?: ReadingField }[];
  rows?: { method: string; evidence?: ReadingField; cells?: { columnID: string; valueText: string; uncertaintyText?: string }[] }[];
}
function ResultComparison({ table }: { table: ResultTable }) {
  const rows = table.rows ?? [];
  const [target, setTarget] = useState(0);
  const [baseline, setBaseline] = useState(1);
  const [confirmed, setConfirmed] = useState(false);
  const numeric = (value?: string) => value && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
  if (rows.length < 2) return null;
  const comparable = target !== baseline && rows[target] && rows[baseline];
  const differences = comparable ? (table.columns ?? []).flatMap((column) => {
    const a = numeric(rows[target]?.cells?.find((cell) => cell.columnID === column.id)?.valueText);
    const b = numeric(rows[baseline]?.cells?.find((cell) => cell.columnID === column.id)?.valueText);
    if (a == null || b == null || !Number.isFinite(a - b)) return [];
    const delta = Number((a - b).toPrecision(6));
    return [{ label: column.label, unit: column.unit, a, b, delta }];
  }) : [];
  return <details className="result-comparison"><summary>对照两行 · 计算同列差值</summary><div className="result-comparison-selects"><label>目标行<select aria-label="差值目标行" value={target} onChange={(e) => { setTarget(Number(e.target.value)); setConfirmed(false); }}>{rows.map((row, i) => <option value={i} key={i}>{row.method}</option>)}</select></label><label>参照行<select aria-label="差值参照行" value={baseline} onChange={(e) => { setBaseline(Number(e.target.value)); setConfirmed(false); }}>{rows.map((row, i) => <option value={i} key={i}>{row.method}</option>)}</select></label></div><label className="result-comparison-confirm"><input type="checkbox" checked={confirmed} disabled={!comparable} onChange={(e) => setConfirmed(e.target.checked)} />相同数据、采集与评测协议</label>{confirmed && comparable && <>{differences.length ? <ul>{differences.map((d, i) => <li key={i}><strong>{d.label}</strong><span>{d.a} − {d.b} = <b>{d.delta > 0 ? '+' : ''}{d.delta}</b>{d.unit && d.unit !== '论文未说明' ? ` ${d.unit}` : '（单位未说明）'}</span></li>)}</ul> : <p>暂无可计算数值</p>}</>}{!comparable && <small>请选择两条不同的结果行。</small>}</details>;
}
export function DetailedResultsBlock({ entry, onCite, renderVisuals }: { entry: ReadingEntry; onCite: (page: number) => void; renderVisuals?: (section: string) => ReactNode }) {
  const payload = parseJSONPayload(entry.value);
  if (!payload.ok) return <div className="whitespace-pre-wrap text-[13px] leading-relaxed"><MathText text={entry.value} /></div>;
  const result = payload.value as Record<string, unknown>;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return <StructuredJSONView value={result} onCite={onCite} />;
  const tables = Array.isArray(result.tables) ? result.tables as ResultTable[] : [];
  if (tables.some((table) => !table || (table.caption && !isReadingField(table.caption)) || (table.protocol && !isReadingField(table.protocol)) || !Array.isArray(table.columns) || !Array.isArray(table.rows) || table.columns.some((column) => !column || typeof column.id !== 'string' || typeof column.label !== 'string' || (column.unit != null && typeof column.unit !== 'string')) || table.rows.some((row) => !row || typeof row.method !== 'string' || !Array.isArray(row.cells) || row.cells.some((cell) => !cell || typeof cell.valueText !== 'string')))) return <StructuredJSONView value={result} onCite={onCite} />;
  return <div>{renderVisuals?.('结果表')}{tables.map((table, index) => <section key={table.id ?? index} className="reading-section">
    <h3><MathText text={table.caption?.v || `结果表 ${index + 1}`} /></h3>
    {table.caption && <EvidenceField field={table.caption} onCite={onCite} />}
    {table.protocol && <EvidenceField field={table.protocol} onCite={onCite} />}
    {table.columns?.some((column) => column.context) && <details><summary>指标定义与单位依据</summary>{table.columns.filter((column) => column.context).map((column) => <EvidenceField key={column.id} field={column.context!} onCite={onCite} />)}</details>}
    <div className="reading-table-scroll"><table><thead><tr><th>方法</th>{table.columns?.map((column) => <th key={column.id}><MathText text={column.label} />{column.unit && <small className="block"><MathText text={column.unit} /></small>}</th>)}</tr></thead>
      <tbody>{table.rows?.map((row, index) => <tr key={index}><th>{row.method}</th>{table.columns?.map((column) => {
        const cell = row.cells?.find((cell) => cell.columnID === column.id);
        return <td key={column.id}>{cell?.valueText ?? '—'}{cell?.uncertaintyText && ` ± ${cell.uncertaintyText}`}</td>;
      })}</tr>)}</tbody></table></div>
    {table.rows?.filter((row) => row.evidence).map((row, index) => <details key={index}><summary>{row.method} · 证据</summary><EvidenceField field={row.evidence!} onCite={onCite} /></details>)}
    <ResultComparison key={entry.updatedAt || entry.value} table={table} />
  </section>)}
    {['stability', 'ablation', 'generalization', 'efficiency', 'statistics', 'missing'].map((group) => {
      const labels: Record<string, string> = { stability: '稳健性', ablation: '组件或分组分析', generalization: '外部验证与泛化', efficiency: '效率与成本', statistics: '统计报告', missing: '缺失与待核对' };
      const rows = result[group];
      return <section key={group} className="reading-section"><h3>{labels[group]}</h3>{renderVisuals?.(labels[group]!)}{Array.isArray(rows) && rows.length ? rows.map((item, index) => typeof item === 'string' ? <p key={index}>{item}</p> : item && <div key={index}>{item.evidence ? <><EvidenceField field={item.evidence} onCite={onCite} /><p className="reproduction-assessment">有条件的解读：{typeof item.interpretation === 'string' ? item.interpretation : ''}</p></> : <EvidenceField field={item} onCite={onCite} />}</div>) : <p className="precision-muted">暂无内容</p>}</section>;
    })}
    {!tables.length && <p>暂无结果表</p>}
  </div>;
}

export function ReproductionNotesBlock({ entry, onCite, renderVisuals }: { entry: ReadingEntry; onCite: (page: number) => void; renderVisuals?: (section: string) => ReactNode }) {
  const payload = parseJSONPayload(entry.value);
  if (!payload.ok) return <div className="whitespace-pre-wrap text-[13px] leading-relaxed"><MathText text={entry.value} /></div>;
  const analysis = payload.value as Record<string, unknown>;
  const labels: Record<string, string> = { resources: '代码、数据与材料', environment: '环境与依赖', cost: '资源成本', missing: '实现缺失', risks: '风险与评估协议' };
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis) || Object.entries(labels).some(([group]) => analysis[group] != null && (!Array.isArray(analysis[group]) || (analysis[group] as unknown[]).some((item) => !item || typeof item !== 'object' || typeof (item as Record<string, unknown>).assessment !== 'string' || typeof (item as Record<string, unknown>).action !== 'string')))) return <StructuredJSONView value={analysis} onCite={onCite} />;
  return <div>{Object.entries(labels).map(([group, label]) => <section key={group} className="reading-section"><h3>{label}</h3>{Array.isArray(analysis[group]) && (analysis[group] as Record<string, unknown>[]).map((item, index) => <div key={index}>
    {item.finding != null && <StructuredJSONView value={item.finding} onCite={onCite} />}<p className="reproduction-assessment"><strong>分析与推断：</strong>{typeof item.assessment === 'string' ? item.assessment : '—'}</p><p className="reproduction-action"><strong>核对行动：</strong>{typeof item.action === 'string' ? item.action : '—'}</p>
  </div>)}{renderVisuals?.(label)}</section>)}</div>;
}
