import { useEffect, useRef, useState } from 'react';
import { bookSources, type SourceBook } from '../../api/bookSources';

export function SourceBookCover({ book }: { book: SourceBook }) {
  const [localURL, setLocalURL] = useState('');
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFailed(false); setLocalURL('');
    if (book.providerId !== 'zlibrary' || !book.coverUrl) return;
    const controller = new AbortController(); let url = '';
    const load = () => {
      void bookSources.cover(book, controller.signal).then(blob => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob); setLocalURL(url);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '150px' });
    if (element.current) observer.observe(element.current);
    return () => { observer.disconnect(); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [book.providerId, book.id, book.coverUrl]);
  let src = localURL;
  if (book.providerId !== 'zlibrary' && book.coverUrl) {
    try { const url = new URL(book.coverUrl); if (url.protocol === 'https:') src = url.href; } catch { /* cover is optional */ }
  }
  return <div ref={element} className="slack-finder__cover">{src && !failed ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span>READ</span>}</div>;
}
