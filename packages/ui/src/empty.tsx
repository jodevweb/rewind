/**
 * The first thing anyone sees.
 *
 * For as long as this was a single centred sentence, the first launch of REWIND looked like a broken
 * application: a dark window, one line of grey text, nothing to do. That is a bad first impression of
 * something that is in fact working correctly — capture starts at launch and there is genuinely
 * nothing to show for the first few minutes.
 *
 * So it says three things, and they are the three the product is arguing for: that a context is not
 * an application, that you can ask it questions, and that nothing leaves the machine. Someone reading
 * this while they wait learns what the window will be for, and the ⌘K line is the only place the
 * command bar is taught before someone needs it.
 */

import { t } from './i18n.js';

const POINTS = [
  { glyph: '◆', title: 'empty.contextsTitle', body: 'empty.contextsBody' },
  { glyph: '⌕', title: 'empty.askTitle', body: 'empty.askBody' },
  { glyph: '▢', title: 'empty.localTitle', body: 'empty.localBody' },
] as const;

export function EmptyState() {
  return (
    <div className="empty-state">
      <span className="empty-pulse" aria-hidden />
      <h2>{t('empty.title')}</h2>
      <p>{t('empty.body')}</p>

      <div className="empty-points">
        <div className="eyebrow">{t('empty.coming')}</div>
        {POINTS.map((point) => (
          <div className="empty-point" key={point.title}>
            <span className="empty-glyph" aria-hidden>
              {point.glyph}
            </span>
            <div>
              <b>{t(point.title)}</b>
              <p>{t(point.body)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
