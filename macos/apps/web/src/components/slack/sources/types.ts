export function formatLabel(format: string): string {
  const value = format.trim();
  return value ? value.toUpperCase() : '文件';
}

export function formatFromInfo(info: string): string {
  const match = /\b(EPUB|PDF|MOBI|AZW3|CBR|CBZ|DJVU|FB2|TXT)\b/i.exec(info);
  return match?.[1]?.toLowerCase() ?? '';
}

export function sizeFromInfo(info: string): string {
  const match = /\b\d+(?:\.\d+)?\s*[KMGT]?B\b/i.exec(info);
  return match?.[0] ?? '';
}
