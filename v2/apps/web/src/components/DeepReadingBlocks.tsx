import type { ReadingEntry } from '../api/client';
import type { ReadingField } from '../hooks/useReadings';

function isReadingField(value: unknown): value is ReadingField {
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return typeof field.k === 'string' && typeof field.v === 'string';
}

export function EvidenceField({ field, onCite }: { field: ReadingField; onCite: (page: number) => void }) {
  if (!isReadingField(field)) return <p>此条目格式无法解析，请对照原始记录。</p>;
  return <div className="reading-fact">
    <strong>{field.k}</strong><p>{field.v}</p>
    {field.page != null && <button onClick={() => onCite(field.page!)}>Page {field.page}</button>}
    {field.excerpt && <details><summary>原文依据</summary><blockquote>{field.excerpt}</blockquote></details>}
  </div>;
}

export function ResearchNotesBlock({ entry, onCite }: { entry: ReadingEntry; onCite: (page: number) => void }) {
  let sections: { title: string; fields: ReadingField[] }[] = [];
  try { const raw = JSON.parse(entry.value); if (raw && Array.isArray(raw.sections)) sections = raw.sections.filter((section: { title?: unknown; fields?: unknown[] } | null) => section && typeof section.title === 'string' && Array.isArray(section.fields) && section.fields.every(isReadingField)); } catch { /* Legacy prose remains readable. */ }
  if (!sections.length) {
    const parts = entry.value.split(/(Page\s+\d+)/g);
    return <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{parts.map((text, index) => /^Page\s+\d+$/.test(text) ? <button key={index} className="text-accent" onClick={() => onCite(Number(text.match(/\d+/)![0]))}>{text}</button> : text)}</div>;
  }
  return <div>{sections.map((section, index) => <section key={index} className="reading-section"><h3>{section.title}</h3>
    {Array.isArray(section.fields) && section.fields.map((field, index) => <EvidenceField key={index} field={field} onCite={onCite} />)}
  </section>)}</div>;
}

interface ResultTable {
  id?: string;
  caption?: ReadingField;
  protocol?: ReadingField;
  columns?: { id: string; label: string; metric?: string; unit?: string; context?: ReadingField }[];
  rows?: { method: string; evidence?: ReadingField; cells?: { columnID: string; valueText: string; uncertaintyText?: string }[] }[];
}
export function DetailedResultsBlock({ entry, onCite }: { entry: ReadingEntry; onCite: (page: number) => void }) {
  let result: Record<string, unknown>;
  try { result = JSON.parse(entry.value); } catch { return <p className="text-bad">结果分析 JSON 无法解析，请重新生成。</p>; }
  if (!result || typeof result !== 'object') return <pre>{entry.value}</pre>;
  const tables = Array.isArray(result.tables) ? result.tables as ResultTable[] : [];
  if (tables.some((table) => !table || (table.caption && !isReadingField(table.caption)) || (table.protocol && !isReadingField(table.protocol)) || !Array.isArray(table.columns) || !Array.isArray(table.rows) || table.columns.some((column) => !column || typeof column.id !== 'string' || typeof column.label !== 'string' || (column.unit != null && typeof column.unit !== 'string')) || table.rows.some((row) => !row || typeof row.method !== 'string' || !Array.isArray(row.cells) || row.cells.some((cell) => !cell || typeof cell.valueText !== 'string')))) return <pre className="whitespace-pre-wrap">{entry.value}</pre>;
  return <div>{tables.map((table, index) => <section key={table.id ?? index} className="reading-section">
    <h3>{table.caption?.v || `结果表 ${index + 1}`}</h3>
    {table.caption && <EvidenceField field={table.caption} onCite={onCite} />}
    {table.protocol && <EvidenceField field={table.protocol} onCite={onCite} />}
    <div className="reading-table-scroll"><table><thead><tr><th>方法</th>{table.columns?.map((column) => <th key={column.id}>{column.label}{column.unit && <small className="block">{column.unit}</small>}</th>)}</tr></thead>
      <tbody>{table.rows?.map((row, index) => <tr key={index}><th>{row.method}</th>{table.columns?.map((column) => {
        const cell = row.cells?.find((cell) => cell.columnID === column.id);
        return <td key={column.id}>{cell?.valueText ?? '—'}{cell?.uncertaintyText && ` ± ${cell.uncertaintyText}`}</td>;
      })}</tr>)}</tbody></table></div>
    {table.rows?.filter((row) => row.evidence).map((row, index) => <details key={index}><summary>{row.method} · 证据</summary><EvidenceField field={row.evidence!} onCite={onCite} /></details>)}
  </section>)}
    {['stability', 'ablation', 'generalization', 'efficiency', 'statistics', 'missing'].map((group) => {
      const labels: Record<string, string> = { stability: '稳定性', ablation: '消融实验', generalization: '泛化能力', efficiency: '效率', statistics: '统计报告', missing: '缺失与待核对' };
      const rows = result[group];
      return Array.isArray(rows) && rows.length > 0 && <section key={group} className="reading-section"><h3>{labels[group]}</h3>{rows.map((item, index) => typeof item === 'string' ? <p key={index}>{item}</p> : item && <div key={index}>{item.evidence ? <><EvidenceField field={item.evidence} onCite={onCite} /><p>{typeof item.interpretation === 'string' ? item.interpretation : ''}</p></> : <EvidenceField field={item} onCite={onCite} />}</div>)}</section>;
    })}
    {!tables.length && <p>本次未提取到结果表；请查看缺失说明并对照原文。</p>}
  </div>;
}

export function ReproductionNotesBlock({ entry, onCite }: { entry: ReadingEntry; onCite: (page: number) => void }) {
  let analysis: Record<string, { finding: ReadingField; assessment: string; action: string }[]>;
  try { analysis = JSON.parse(entry.value); } catch { return <p>复现计划格式无法解析，请重新生成。</p>; }
  if (!analysis || typeof analysis !== 'object' || Object.values(analysis).some((items) => !Array.isArray(items) || items.some((item) => !item || typeof item.assessment !== 'string' || typeof item.action !== 'string'))) return <pre className="whitespace-pre-wrap">{entry.value}</pre>;
  const labels: Record<string, string> = { resources: '代码、数据与权重', environment: '环境与依赖', cost: '训练成本', missing: '实现缺失', risks: '风险与评测协议' };
  return <div>{Object.entries(labels).map(([group, label]) => <section key={group} className="reading-section"><h3>{label}</h3>{Array.isArray(analysis[group]) && analysis[group]!.map((item, index) => <div key={index}>
    {item.finding && <EvidenceField field={item.finding} onCite={onCite} />}<p>分析：{item.assessment}</p><p>核对行动：{item.action}</p>
  </div>)}</section>)}</div>;
}
