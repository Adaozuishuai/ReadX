/**
 * 浏览器下载的唯一实现。原项目 8 份 `createObjectURL + a.click + revoke` 样板
 *（client.ts ×4、DocumentJobDialog、ExportPDFDialog、PrecisionReading、
 * LatexWorkspace）收敛于此。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
