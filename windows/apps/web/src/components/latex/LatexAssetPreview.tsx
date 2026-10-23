export function LatexAssetPreview({
  path,
  asset,
  loading,
  error,
}: {
  path: string;
  asset: { url: string; contentType: string; size: number } | null;
  loading: boolean;
  error: string;
}) {
  const name = path.split('/').at(-1) || path;
  return (
    <section className="latex-asset-preview" aria-label={`资源预览：${path}`}>
      <header>
        <span title={path}>{path}</span>
        {asset ? <small>{(asset.size / 1024).toFixed(asset.size > 1024 * 1024 ? 0 : 1)} KB</small> : null}
        {asset ? <a href={asset.url} download={name}>下载</a> : null}
      </header>
      {loading ? <p className="latex-asset-message">正在读取资源…</p> : null}
      {!loading && error ? <p className="latex-asset-message error" role="alert">{error}</p> : null}
      {!loading && !error && asset?.contentType.startsWith('image/') ? (
        <div className="latex-asset-stage"><img src={asset.url} alt={name} /></div>
      ) : null}
      {!loading && !error && asset && !asset.contentType.startsWith('image/') ? (
        <div className="latex-asset-message">
          <strong>{asset.contentType === 'application/pdf' ? 'PDF 资源' : '二进制资源'}</strong>
          <span>文件已加入项目，可下载查看或在 LaTeX 中引用。</span>
        </div>
      ) : null}
    </section>
  );
}
