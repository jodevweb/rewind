/**
 * Handoff — taking a context out of REWIND and into the next thing you do with it.
 *
 * Three destinations, one rule. REWIND reconstructs your day well enough that you then have to
 * retype it: into an agent that has no idea what you were doing, into a standup, into a worklog.
 * That retyping is the tool's own cost, and it is the one thing it can remove entirely.
 *
 * The rule is the one the Resume card already lives by: **every line here is read from a stored
 * event.** Nothing is summarised, nothing is inferred, no sentence is invented. What is copied is
 * exactly what is on screen, in a shape the destination accepts.
 *
 * Why this lives in the UI package and not in the engine: the engine returns which rule fired and
 * with what values, never prose, because prose cannot be translated at the point of display (§147).
 * A brief is prose. So it is assembled here, where the dictionary is.
 */

import type { EngineContext, NextStep, ResumeCard } from '@rewind/engine-v0';

import { formatDuration, t, tPlural } from './i18n.js';

export type Place = EngineContext['place'];

/** One context, ready to be handed over. */
export interface Handoff {
  card: ResumeCard;
  place?: Place;
}

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

const placeLine = (place?: Place): string =>
  [place?.project, place?.repository, place?.branch].filter(Boolean).join(' · ');

/**
 * The suggested next step, as a sentence.
 *
 * Duplicated from the Resume card's renderer on purpose: that one returns a React-rendered string
 * for a panel, this one goes into a text file. Sharing it would mean one of the two callers getting
 * markup it cannot use.
 */
export function nextStepSentence(step: NextStep): string {
  switch (step.rule) {
    case 'quote_note':
      return step.text;
    case 'fix_failing_command':
      return `${t('next.fixFailing')} ${step.command}`;
    case 'commit_or_stash':
      return [
        t('next.commitOrStash'),
        step.count,
        tPlural('next.files', step.count),
        step.branch ? `${t('next.onBranch')} ${step.branch}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'review_agent_work':
      return t('next.reviewAgent');
  }
}

const section = (label: string, lines: { label: string; detail?: string }[]): string[] => {
  if (lines.length === 0) return [];
  return [`${label} : ${lines.map((l) => l.label).join(', ')}`];
};

/**
 * A context, written for an agent that knows nothing about it.
 *
 * The shape is deliberately flat and labelled rather than narrative: an agent reading this needs to
 * find the branch, the failing command and the files, not to enjoy a paragraph. The last line says
 * where it came from, because an agent handed unattributed facts will treat them as its own
 * assumptions and defend them.
 */
export function agentBrief({ card, place }: Handoff, tz: number): string {
  const where = placeLine(place);
  const lines: string[] = [
    `${t('handoff.context')} : ${card.contextLabel}`,
    ...(where ? [`${t('handoff.place')} : ${where}`] : []),
    `${t('handoff.lastActivity')} : ${clock(card.lastActiveAt, tz)} · ${formatDuration(card.activeMs)} ${t('resume.active')}`,
    ...(card.appChain.length > 0 ? [`${t('handoff.apps')} : ${card.appChain.join(' → ')}`] : []),
    '',
    ...section(t('resume.files'), card.working),
    ...section(t('resume.reading'), card.reading),
    ...section(
      t('resume.ran'),
      card.ran.map((l) => ({ label: `${l.label} (${l.detail ?? ''})`.replace(' ()', '') })),
    ),
    ...section(t('resume.failed'), card.failures),
    ...section(t('resume.produced'), card.produced),
  ];

  if (card.nextStep) lines.push('', `${t('resume.nextStep')} : ${nextStepSentence(card.nextStep)}`);

  if (card.openResources.length > 0) {
    lines.push('', `${t('handoff.reopen')} :`);
    for (const r of card.openResources) lines.push(`- ${r.kind} ${r.target}`);
  }

  lines.push('', t('handoff.provenance'));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * One context, one line — the shape a standup wants.
 *
 * Duration first because that is the part nobody remembers, then what came out of it. A context
 * that produced nothing says so by being short, never by being padded.
 */
export function standupLine({ card, place }: Handoff): string {
  const where = placeLine(place);
  const produced = card.produced.map((l) => l.label).slice(0, 2);
  const failed = card.failures.length > 0 ? t('handoff.blocked') : '';
  const tail = [...produced, failed].filter(Boolean).join(' · ');
  return `- ${card.contextLabel}${where ? ` (${where})` : ''} — ${formatDuration(card.activeMs)}${tail ? ` — ${tail}` : ''}`;
}

/** Every context of one day, newest last, as a standup someone can paste and send. */
export function standup(day: string, items: Handoff[]): string {
  const kept = items.filter((i) => i.card.activeMs > 0);
  return [
    `${t('handoff.standupTitle')} — ${day}`,
    ...kept.map(standupLine),
    '',
    t('handoff.provenance'),
  ].join('\n');
}

/**
 * The long form: every context of the day with what it touched.
 *
 * This is the one that goes into a timesheet, an invoice or a weekly report — the places where the
 * question is not "what did I do" but "what did I do, in enough detail that someone else believes
 * it". Hence the evidence lines rather than a duration.
 */
export function worklog(day: string, items: Handoff[], tz: number): string {
  const out: string[] = [`# ${t('handoff.worklogTitle')} — ${day}`, ''];
  for (const item of items) {
    const { card, place } = item;
    const where = placeLine(place);
    out.push(`## ${card.contextLabel}${where ? ` — ${where}` : ''}`);
    out.push(
      `${formatDuration(card.activeMs)} ${t('resume.active')} · ${t('resume.lastActivity').toLowerCase()} ${clock(card.lastActiveAt, tz)}`,
    );
    const body = [
      ...section(t('resume.files'), card.working),
      ...section(t('resume.ran'), card.ran),
      ...section(t('resume.produced'), card.produced),
      ...section(t('resume.failed'), card.failures),
    ];
    if (body.length > 0) out.push('', ...body);
    if (card.nextStep) out.push('', `${t('resume.nextStep')} : ${nextStepSentence(card.nextStep)}`);
    out.push('');
  }
  out.push(t('handoff.provenance'));
  return out.join('\n');
}

/**
 * Put text on the clipboard.
 *
 * `navigator.clipboard.writeText` is the API; the fallback exists because it is only available in a
 * secure context, and a Tauri webview is not one on every platform. The fallback writes rather than
 * reads — reading the clipboard is banned outright and checked on every build (PRIVACY §2).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through: a rejected permission is not a reason to lose the text.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
