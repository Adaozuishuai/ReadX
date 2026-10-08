// 论文发现：正式期刊/会议为主流，arXiv 预印本独立返回。

import { QueueEntry } from '../core/types';
import { arxivKey, deduplicate } from '../core/paper';

const UA = 'cbct-reading-windows/0.1 (research reading assistant)';

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  // 出站请求必须有超时：单源挂起不能拖死整次刷新
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim() : null;
}

function allTags(block: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim());
  return out;
}

export async function arxiv(): Promise<QueueEntry[]> {
  const url = 'https://export.arxiv.org/api/query?' + new URLSearchParams({
    search_query: 'abs:CBCT OR abs:"cone-beam CT" OR abs:"cone beam computed tomography"',
    start: '0', max_results: '40', sortBy: 'submittedDate', sortOrder: 'descending',
  }).toString();
  const xml = await fetchText(url);
  const out: QueueEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const rawId = tag(block, 'id') ?? '';
    if (!rawId.includes('arxiv.org/abs/')) continue;
    const title = tag(block, 'title') ?? '';
    if (!title) continue;
    const id = arxivKey(rawId);
    out.push({
      arxiv: id,
      title,
      authors: allTags(block, 'name'),
      venue: preferredVenue(tag(block, 'journal_ref') ?? '') ? (tag(block, 'journal_ref') ?? '') : 'arXiv',
      pdfUrl: `https://arxiv.org/pdf/${id}`,
      abstract: tag(block, 'summary') ?? undefined,
      published: tag(block, 'published') ?? undefined,
      source: preferredVenue(tag(block, 'journal_ref') ?? '') ?? 'arXiv 预印本',
    });
  }
  return deduplicate(out);
}

const venueCues: Array<[string, string[]]> = [
  ['MICCAI', ['miccai', 'medical image computing and computer-assisted intervention']],
  ['CVPR', ['cvpr', 'computer vision and pattern recognition']],
  ['ICCV', ['iccv', 'international conference on computer vision']],
  ['ECCV', ['eccv', 'european conference on computer vision']],
  ['NeurIPS', ['neurips', 'neural information processing systems']],
  ['ICLR', ['iclr', 'international conference on learning representations']],
  ['AAAI', ['aaai', 'association for the advancement of artificial intelligence']],
  ['ISBI', ['isbi', 'international symposium on biomedical imaging']],
  ['SPIE Medical Imaging', ['spie medical imaging', 'medical imaging (spie)']],
  ['TMI', ['ieee transactions on medical imaging', 'trans. med. imaging', 'trans med imaging']],
  ['MIA', ['medical image analysis']],
];

export function preferredVenue(raw: string): string | null {
  const venue = raw.toLowerCase();
  // Proceedings metadata may include the parent conference name for workshops.
  // Keep those out of the accepted main-conference feed.
  if (/\bworkshops?\b|\bwork in progress\b/.test(venue)) return null;
  return venueCues.find(([, cues]) => cues.some((cue) => venue.includes(cue)))?.[0] ?? null;
}

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  year?: number;
  venue?: string;
  publicationDate?: string;
  authors?: Array<{ name?: string }>;
  externalIds?: { DOI?: string };
  openAccessPdf?: { url?: string };
}

async function semanticScholar(query: string): Promise<QueueEntry[]> {
  const url = 'https://api.semanticscholar.org/graph/v1/paper/search?' + new URLSearchParams({
    query,
    fields: 'title,abstract,year,venue,publicationDate,authors,externalIds,openAccessPdf',
    limit: '100',
  }).toString();
  const response = await fetchText(url);
  const body = JSON.parse(response) as { data?: S2Paper[] };
  return (body.data ?? []).flatMap((paper) => {
    const title = paper.title?.trim();
    const venue = paper.venue?.trim() ?? '';
    const source = preferredVenue(venue);
    if (!title || !source || !paper.paperId) return [];
    return [{
      id: `s2-${paper.paperId}`, title, venue, source,
      authors: paper.authors?.flatMap((author) => author.name ? [author.name] : []),
      abstract: paper.abstract ?? undefined,
      published: paper.publicationDate ?? (paper.year ? String(paper.year) : undefined),
      doi: paper.externalIds?.DOI,
      pdfUrl: paper.openAccessPdf?.url,
    }];
  });
}

/** Query more than one relevant topic, then filter using publisher/venue metadata. */
export async function conferences(): Promise<QueueEntry[]> {
  const queries = ['cone-beam CT reconstruction', 'sparse-view CT reconstruction'];
  const found: QueueEntry[] = [];
  for (const [index, query] of queries.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1_500));
    found.push(...await semanticScholar(query));
  }
  return deduplicate(found);
}

export async function pubmed(): Promise<QueueEntry[]> {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
  const term = '(CBCT[Title/Abstract] OR cone-beam[Title/Abstract] OR cone beam[Title/Abstract]) AND reconstruction[Title/Abstract]';
  const searchXml = await fetchText(base + 'esearch.fcgi?' + new URLSearchParams({
    db: 'pubmed', term, retmax: '30', sort: 'pub_date', retmode: 'xml', tool: 'cbct_research_copilot',
  }).toString());
  const ids = allTags(searchXml, 'Id');
  if (!ids.length) return [];
  const xml = await fetchText(base + 'efetch.fcgi?' + new URLSearchParams({
    db: 'pubmed', id: ids.join(','), retmode: 'xml', tool: 'cbct_research_copilot',
  }).toString());

  const out: QueueEntry[] = [];
  const re = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const pmid = tag(block, 'PMID');
    const title = tag(block, 'ArticleTitle');
    if (!pmid || !title) continue;
    const authors = allTags(block, 'LastName');
    // 结构化摘要：保留 "Label: text" 前缀，否则会丢掉分组语义
    const abstract = allTags(block, 'AbstractText').join('\n');
    out.push({
      id: `pubmed-${pmid}`,
      title,
      authors,
      venue: tag(block, 'Title') ?? 'PubMed',
      abstract: abstract || undefined,
      published: tag(block, 'PubDate') ?? undefined,
      source: 'pubmed',
      // PubMed 不保证可下载全文，这里不伪造 pdfUrl
    });
  }
  return deduplicate(out);
}

export interface DiscoveryResult { papers: QueueEntry[]; preprints: QueueEntry[]; errors: string[] }

/** 单源故障降级：一个源失败不影响另一个源的结果。 */
export async function discover(): Promise<DiscoveryResult> {
  const errors: string[] = [];
  const settled = await Promise.allSettled([conferences(), arxiv(), pubmed()]);
  const papers: QueueEntry[] = [], preprints: QueueEntry[] = [];
  const labels = ['期刊会议', 'arXiv', 'PubMed'];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (i === 1) {
        papers.push(...r.value.filter((paper) => paper.source !== 'arXiv 预印本'));
        preprints.push(...r.value.filter((paper) => paper.source === 'arXiv 预印本'));
      } else papers.push(...r.value);
    }
    else errors.push(`${labels[i]} 暂时不可用：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  return { papers: deduplicate(papers), preprints: deduplicate(preprints), errors };
}
