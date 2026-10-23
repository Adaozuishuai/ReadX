export interface WebSearchRules {
  list: string;
  name: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  lastChapter: string;
}

export interface WebBookRules {
  name: string;
  author: string;
  intro: string;
  cover: string;
  tocUrl: string;
}

export interface WebTocRules {
  list: string;
  name: string;
  url: string;
}

export interface WebContentRules {
  content: string;
  remove: string;
  next: string;
}

export interface WebSourceRules {
  search: WebSearchRules;
  book: WebBookRules;
  toc: WebTocRules;
  content: WebContentRules;
}

export interface WebBookSource {
  id: string;
  name: string;
  baseUrl: string;
  charset: string;
  searchUrl: string;
  rules: WebSourceRules;
  enabled: boolean;
  /** 非空表示这个书源使用了当前引擎不支持的规则。 */
  unsupported?: string;
}

export interface WebSearchResult {
  sourceId: string;
  sourceName: string;
  title: string;
  author: string;
  bookUrl: string;
  cover: string;
  intro: string;
  lastChapter: string;
}

export interface WebBookDetail {
  title: string;
  author: string;
  intro: string;
  cover: string;
  chapters: { title: string; url: string }[];
}
