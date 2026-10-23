export function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function absoluteURL(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function swapHost(raw: string, mirror: string): string {
  try {
    const source = new URL(raw);
    const target = new URL(mirror);
    source.protocol = target.protocol;
    source.host = target.host;
    return source.toString();
  } catch {
    return raw;
  }
}

export function withTimeout(signal: AbortSignal | undefined, milliseconds = 15_000): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Cloudflare / DDoS-Guard 的典型拦截页；用于换镜像而不是把空结果当成真的没搜到。 */
export function looksLikeChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim().toLowerCase() ?? '';
  if (
    title.startsWith('just a moment') ||
    title.startsWith('attention required') ||
    title.startsWith('ddos-guard') ||
    title.startsWith('checking your browser')
  ) {
    return true;
  }
  return [
    'cf-browser-verification',
    'cf-challenge-running',
    '/cdn-cgi/challenge-platform/',
    'check.ddos-guard.net',
    'data-ddg-origin',
    '__ddg',
  ].some((marker) => lower.includes(marker));
}

export function collapseLines(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}
