import type { CSSProperties } from 'react';
import { categoryDot } from '../categories';
import './shelf-cover.css';

/** A collection jacket, with its accent shared by the sidebar shelf. */
export function ShelfCover({ name, color, count, index }: { name: string; color: string; count: number; index: number }) {
  return <header className="shelf-cover" style={{ '--shelf-accent': categoryDot(color) } as CSSProperties}>
    <div className="shelf-cover-copy">
      <span className="shelf-cover-edition">READX <i /> COLLECTION {String(index + 1).padStart(2, '0')}</span>
      <h2>{name}</h2>
      <span className="shelf-cover-count"><strong>{count}</strong> 篇文献</span>
    </div>
    <svg className="shelf-cover-art" viewBox="0 0 300 164" fill="none" aria-hidden="true">
      <circle cx="198" cy="79" r="68" fill="currentColor" opacity=".06" />
      <circle cx="198" cy="79" r="51" stroke="currentColor" opacity=".15" />
      <path d="M25 143h254" stroke="currentColor" strokeWidth="2" opacity=".3" />
      <g transform="translate(45 39)">
        <rect width="28" height="102" rx="3" fill="currentColor" opacity=".85" />
        <path d="M6 0v102M12 15h10M12 20h10M12 84h10" stroke="var(--color-surface)" opacity=".6" />
      </g>
      <g transform="translate(78 21)">
        <rect width="39" height="120" rx="3" fill="currentColor" opacity=".24" />
        <path d="M7 0v120M14 19h18M14 24h18M14 100h18M14 104h18" stroke="currentColor" opacity=".5" />
        <circle cx="23" cy="62" r="9" stroke="currentColor" opacity=".45" />
      </g>
      <g transform="translate(123 48)">
        <rect width="23" height="93" rx="3" fill="currentColor" opacity=".55" />
        <path d="M5 0v93M10 13h8M10 17h8M10 78h8" stroke="var(--color-surface)" opacity=".7" />
      </g>
      <g transform="translate(151 32) rotate(-10 14 109)">
        <rect width="29" height="109" rx="3" fill="currentColor" opacity=".17" />
        <path d="M6 0v109M12 16h11M12 21h11M12 91h11" stroke="currentColor" opacity=".5" />
      </g>
      <rect x="192" y="128" width="65" height="13" rx="3" fill="currentColor" opacity=".7" />
      <rect x="201" y="111" width="62" height="13" rx="3" fill="currentColor" opacity=".2" />
      <path d="M201 134h46M210 117h43" stroke="var(--color-surface)" opacity=".7" />
      <path d="M247 43v14M240 50h14" stroke="currentColor" strokeLinecap="round" opacity=".5" />
    </svg>
  </header>;
}
