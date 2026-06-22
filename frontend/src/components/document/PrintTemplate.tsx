/**
 * components/document/PrintTemplate.tsx — Hidden Print Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure semantic HTML for window.print(). Hidden on screen, shown on print.
 *
 * candidateName and contactInfo are now first-class store fields — no more
 * extraction from sections. The parser guarantees they are always present.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { useDocumentStore } from '@/store/useDocumentStore';
import type { ResumeBullet } from '@/lib/types';

type BulletGroup =
  | { type: 'meta';    items: ResumeBullet[] }
  | { type: 'content'; items: ResumeBullet[] };

function groupBullets(bullets: ResumeBullet[]): BulletGroup[] {
  const groups: BulletGroup[] = [];
  for (const bullet of bullets) {
    const type = bullet.isMeta ? 'meta' : 'content';
    const last  = groups[groups.length - 1];
    if (last && last.type === type) {
      last.items.push(bullet);
    } else {
      groups.push({ type, items: [bullet] } as BulletGroup);
    }
  }
  return groups;
}

export default function PrintTemplate() {
  const resumeSections = useDocumentStore(s => s.resumeSections);
  const candidateName  = useDocumentStore(s => s.candidateName);
  const contactInfo    = useDocumentStore(s => s.contactInfo);

  const contactLine = contactInfo.filter(Boolean).join(' · ');

  return (
    <div className="print-only-resume">

      {/* ── Candidate header ─────────────────────────────────────────────── */}
      {(candidateName || contactLine) && (
        <header className="print-contact">
          {candidateName && candidateName !== 'Unknown' && (
            <h1 className="print-contact-name">{candidateName}</h1>
          )}
          {contactLine && (
            <p className="print-contact-meta">{contactLine}</p>
          )}
        </header>
      )}

      {/* ── Body sections (Contact section excluded by parser) ───────────── */}
      {resumeSections
        .filter(s => s.title !== 'Contact')   // defensive: skip any stray Contact
        .map(section => {

          // Summary → prose paragraphs
          if (section.title === 'Summary') {
            const paras = section.bullets.filter(b => !b.isMeta);
            if (paras.length === 0) return null;
            return (
              <div key={section.id} className="print-section">
                <h2 className="print-section-title">Summary</h2>
                {paras.map(b => (
                  <p key={b.id} className="print-summary-text">{b.text}</p>
                ))}
              </div>
            );
          }

          // All other sections → grouped meta sub-headers + bullet lists
          const groups = groupBullets(section.bullets);
          if (groups.length === 0) return null;

          return (
            <div key={section.id} className="print-section">
              <h2 className="print-section-title">{section.title}</h2>
              {groups.map((group, gi) => {
                if (group.type === 'meta') {
                  return (
                    <div key={gi} className="print-meta-group">
                      {group.items.map((b, i) => (
                        <p key={b.id} className={i === 0 ? 'print-meta-primary' : 'print-meta-secondary'}>
                          {b.text}
                        </p>
                      ))}
                    </div>
                  );
                }
                return (
                  <ul key={gi} className="print-bullets">
                    {group.items.map(b => (
                      <li key={b.id}>{b.text}</li>
                    ))}
                  </ul>
                );
              })}
            </div>
          );
        })}

    </div>
  );
}
