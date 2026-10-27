import type { CSSProperties } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { categoryDot } from '../categories';
import { chooseShelfSubject, seedFor, SubjectDrawing } from './PaperLineArt';
import './shelf-cover.css';

/** The shelf name takes precedence; a broad name can use its documents' titles. */
export function ShelfCover({ name, color, documents, index }: { name: string; color: string; documents: DocumentSummary[]; index: number }) {
  const subject = chooseShelfSubject(name, documents);
  const seed = seedFor(name);
  const variant = seed % 3;
  const angle = ((seed >>> 5) % 9) - 4;
  return <header className="shelf-cover" style={{ '--shelf-accent': categoryDot(color) } as CSSProperties}>
    <div className="shelf-cover-copy">
      <span className="shelf-cover-edition">READX <i /> COLLECTION {String(index + 1).padStart(2, '0')}</span>
      <h2>{name}</h2>
      <span className="shelf-cover-count"><strong>{documents.length}</strong> 篇文献</span>
    </div>
    <div className="shelf-cover-story" aria-hidden="true">
      <svg viewBox="0 0 200 190" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
        <SubjectDrawing subject={subject} variant={(variant + 1) % 3} />
      </svg>
      <span className="shelf-cover-story-link"><i /><i /><i /></span>
      <svg viewBox="0 0 200 190" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
        <SubjectDrawing subject={subject} variant={(variant + 2) % 3} />
      </svg>
    </div>
    <svg className="shelf-cover-art" viewBox="0 0 300 164" fill="none" aria-hidden="true">
      <circle cx="197" cy="82" r="69" fill="currentColor" opacity=".06" />
      <circle cx="197" cy="82" r="60" stroke="currentColor" opacity=".2" strokeDasharray="2 7" />
      <path d="M20 143h260M33 151h87M230 17h28M243 23h15" stroke="currentColor" strokeWidth="1" opacity=".35" />
      <g transform={`translate(115 0) scale(.85) rotate(${angle} 100 95)`} stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" opacity=".72">
        <SubjectDrawing subject={subject} variant={variant} />
      </g>
      <path d="M65 52v14M58 59h14M267 108v12M261 114h12" stroke="currentColor" strokeLinecap="round" opacity=".48" />
    </svg>
  </header>;
}
