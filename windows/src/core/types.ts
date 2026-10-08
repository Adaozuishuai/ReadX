// 数据模型：与 macOS 版 Swift 结构逐字段对应。
// 字段名刻意保持与 JSON 一致（camelCase），确保 app/data/*.json 双向兼容。

export interface QueueEntry {
  arxiv?: string | null;
  id?: string | null;
  title?: string | null;
  authors?: string[] | null;
  venue?: string | null;
  year?: string | null;
  pdfUrl?: string | null;
  abstract?: string | null;
  why?: string | null;
  doi?: string | null;
  source?: string | null;
  published?: string | null;
}

export interface ResearchProfile {
  topics: Record<string, number>;
  datasets: string;
  methods: string;
  metrics: string;
  hardware: string;
  task: string;
}

export type LibraryStatus =
  | 'unread' | 'later' | 'reading' | 'read' | 'ignored' | 'deleted';

export interface LibraryState {
  status: LibraryStatus;
  favorite: boolean;
  tags: string[];
  notes: string;
  relevance: number; // -1 不相关，0 未评价，1 相关
  corrections: string;
  updatedAt: string;
}

export interface DiscoveryCache {
  papers: QueueEntry[];
  fetchedAt: string;
  errors: string[];
  firstSeen: Record<string, string>;
}

export interface Config {
  baseURL?: string | null;
  apiKey?: string | null;
  model?: string | null;
  port?: number | null;
  githubToken?: string | null;
  embeddingModel?: string | null;
}

export interface ProgressEntry {
  startedAt?: string | null;
  step?: number | null;
  doneAt?: string | null;
  reflections?: Record<string, string> | null;
  freeNote?: string | null;
}

export interface ChatMsg {
  role: 'user' | 'ai';
  text: string;
}

/** 实验抽取字段：每个值都必须能回到页码 + 逐字摘录。 */
export interface ExperimentField {
  k: string;
  v: string;
  page?: number | null;
  excerpt?: string | null;
}

export interface ExperimentExtraction {
  dataset: ExperimentField[];
  acquisition: ExperimentField[];
  training: ExperimentField[];
  loss: ExperimentField[];
  metrics: ExperimentField[];
  results: ExperimentField[];
  baselines?: ExperimentField[] | null;
}

/** 与 Swift 的 ResearchProfile 默认值保持一致。 */
export function defaultProfile(): ResearchProfile {
  return {
    topics: {
      'Sparse-view': 3, 'Low-dose': 2, Implicit: 2,
      '4D-CBCT': 0, Diffusion: 1, TTT: 0,
    },
    datasets: 'Walnut, LUNA16, AAPM',
    methods: 'Implicit Representation, Transformer',
    metrics: 'PSNR, SSIM, RMSE',
    hardware: '单卡 16 GB GPU',
    task: '稀疏视角 CBCT 体重建',
  };
}

export function defaultLibraryState(): LibraryState {
  return {
    status: 'unread', favorite: false, tags: [], notes: '',
    relevance: 0, corrections: '', updatedAt: '',
  };
}

export const LIBRARY_STATUS_LABEL: Record<LibraryStatus, string> = {
  unread: '未读', later: '稍后读', reading: '精读中',
  read: '已读', ignored: '忽略', deleted: '已删除',
};

export const PROFILE_KEYWORDS: Record<string, string[]> = {
  'Sparse-view': ['sparse-view', 'sparse view', 'few-view', 'few view'],
  'Low-dose': ['low-dose', 'low dose', 'low-mas'],
  Implicit: ['implicit', 'neural field', 'attenuation field', 'gaussian representation'],
  '4D-CBCT': ['4d', 'motion', 'dynamic'],
  Diffusion: ['diffusion', 'score-based'],
  TTT: ['test-time', 'test time', 'scan-adaptive'],
};
