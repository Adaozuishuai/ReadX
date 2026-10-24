/** Stable identity across sources and file names; never deduplicate by title. */
export async function contentHash(file: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
}
