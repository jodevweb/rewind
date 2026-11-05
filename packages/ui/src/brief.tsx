/**
 * The morning brief — the first thing you see on a day that has barely started.
 *
 * REWIND could already tell you where you left off, and you had to go and ask it. The ten minutes
 * this product exists to save are spent before you would think to open it: reconstructing yesterday
 * from a branch name, an editor's recent files and a terminal's scrollback.
 *
 * # Why this is a banner and not a notification
 *
 * An operating-system notification would reach you without opening anything, and it is the wrong
 * shape. This product refuses to nag — the prediction panels disappear rather than show a hedge, and
 * nothing here scores anybody. A notification that fires every morning whether or not it has
 * something to say gets muted in a week, and a muted channel cannot be un-muted by being right
 * later. A banner costs nothing when it is wrong and is there when it is useful.
 *
 * So the rule is the one the prediction layer already lives by: **withhold**. No previous day, no
 * context worth naming, or a day already well under way — and there is no brief at all.
 */

import { useState } from 'react';

import { buildResume, runEngine } from '@rewind/engine-v0';
import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { workDay } from '@rewind/predict';

import { agentBrief, copyText, nextStepSentence, type Handoff } from './handoff.js';
import { formatDuration, t } from './i18n.js';
import type { WorkspaceActions } from './workspace.js';

/**
 * Past this many events, today is no longer "a day that has barely started" and you know perfectly
 * well what you are doing. Roughly a quarter of an hour of ordinary window switching.
 */
export const BRIEF_MAX_EVENTS_TODAY = 40;

export interface MorningBrief {
  /** The work day it describes — yesterday, or the last day there was any work at all. */
  day: string;
  handoff: Handoff;
}

/**
 * What you were on when you last stopped.
 *
 * Read from the recent stream across days rather than from today, because the answer is by
 * definition not in today. Returns `null` rather than a hedge whenever it cannot be sure.
 */
export function morningBrief(
  history: GoldenSession,
  today: string,
  eventsToday: number,
): MorningBrief | null {
  if (eventsToday > BRIEF_MAX_EVENTS_TODAY) return null;

  const byDay = new Map<string, GoldenEvent[]>();
  for (const event of history.events) {
    const day = workDay(event.timestamp, event.tzOffsetMinutes);
    if (day >= today) continue;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(event);
    else byDay.set(day, [event]);
  }
  if (byDay.size === 0) return null;

  const day = [...byDay.keys()].sort().pop()!;
  const events = byDay.get(day)!.sort((a, b) => a.timestamp - b.timestamp);

  // One day at a time, exactly as the engine expects: a fortnight in one call lets last Tuesday's
  // anchors compete with yesterday's.
  const session: GoldenSession = { ...history, id: `brief-${day}`, day, events };
  const contexts = runEngine(session).contexts;
  if (contexts.length === 0) return null;

  const last = contexts.reduce((a, b) => (b.endTimestamp > a.endTimestamp ? b : a));
  // A context nobody spent any time in is not where you left off.
  if (last.activeMs <= 0) return null;

  return { day, handoff: { card: buildResume(session, last), place: last.place } };
}

/**
 * The brief, and the two things worth doing with it: get back into it, or hand it to an agent.
 *
 * Dismissible, and dismissed for the session only. It is a greeting, not a task.
 */
export function MorningBriefBanner({
  brief,
  tz,
  actions,
  onGoToDay,
}: {
  brief: MorningBrief;
  tz: number;
  actions?: WorkspaceActions;
  /** Read the whole day it came from, rather than take its word for it. */
  onGoToDay?: (day: string) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  if (dismissed) return null;

  const { card, place } = brief.handoff;
  const where = [place?.project, place?.repository, place?.branch].filter(Boolean).join(' · ');
  const resources = card.openResources;

  const copy = async () => {
    const ok = await copyText(agentBrief(brief.handoff, tz));
    setFlash(ok ? t('handoff.copied') : t('handoff.copyFailed'));
    setTimeout(() => setFlash(null), 2000);
  };

  return (
    <div className="banner brief">
      <button className="close" onClick={() => setDismissed(true)} aria-label={t('brief.dismiss')}>
        ×
      </button>
      <div className="brief-body">
        <div className="eyebrow">{t('brief.title')}</div>
        <p className="brief-line">
          <b>{card.contextLabel}</b>
          {where && <span className="mono brief-where">{where}</span>}
          <span className="brief-dur">{formatDuration(card.activeMs)}</span>
        </p>
        {card.nextStep && <p className="brief-next">{nextStepSentence(card.nextStep)}</p>}
      </div>

      <div className="handoff-bar">
        {actions?.open && resources.length > 0 && (
          <button
            className="primary"
            onClick={() => resources.forEach((r) => actions.open?.(r.target))}
          >
            {t('handoff.reopenAll')}
            <span className="count">{resources.length}</span>
          </button>
        )}
        <button className="ghost" onClick={() => void copy()}>
          {t('handoff.brief')}
        </button>
        {onGoToDay && (
          <button className="ghost" onClick={() => onGoToDay(brief.day)}>
            {t('brief.seeDay')}
          </button>
        )}
        {flash && <span className="flash">{flash}</span>}
      </div>
    </div>
  );
}
