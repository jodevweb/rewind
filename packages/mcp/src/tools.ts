/**
 * What an agent can ask REWIND, and what it gets back.
 *
 * Four questions, all answered from stored events, all deterministic. They are the same four the
 * window answers, which is deliberate: an agent that gets a different answer from the one on screen
 * is a second source of truth, and the day the two disagree is the day both become useless.
 *
 * Everything returned is plain text, because the consumer is a language model and text is what it
 * reads. It is *assembled* text — labelled lines read from events — never generated prose, and it
 * always ends with the line saying where it came from. An agent handed unattributed facts treats
 * them as its own assumptions and defends them.
 */

import { buildResume, runEngine } from '@rewind/engine-v0';
import { ask, prepare } from '@rewind/ask';
import { workDay } from '@rewind/predict';
import { toSession } from '@rewind/shared';
import { agentBrief, standup, worklog, type Handoff } from '@rewind/ui/handoff';

import type { Store } from './db.js';

/** How much history a question is allowed to reach back through. */
const HISTORY_LIMIT = 20_000;

/** The day to read when none was named: today if it has anything in it, else the last one that has. */
function defaultDay(store: Store, now: number): string | null {
  const days = store.days(400);
  if (days.length === 0) return null;
  const today = workDay(now, -new Date(now).getTimezoneOffset());
  return days.some((d) => d.day === today) ? today : (days[0]?.day ?? null);
}

function handoffsFor(store: Store, day: string): { handoffs: Handoff[]; tz: number } {
  const session = toSession(store.forDay(day), day, day);
  const contexts = runEngine(session).contexts;
  return {
    handoffs: contexts.map((c) => ({ card: buildResume(session, c), place: c.place })),
    tz: session.tzOffsetMinutes,
  };
}

const NOTHING = 'REWIND: rien d’enregistré pour cette période.';

/**
 * Where you left off — the last context of a day, in full.
 *
 * The single most useful thing to hand an agent at the start of a session: the branch, the files,
 * the command that failed and what REWIND thinks the next step is.
 */
export function resumeText(store: Store, day: string | undefined, now: number): string {
  const target = day ?? defaultDay(store, now);
  if (!target) return NOTHING;
  const { handoffs, tz } = handoffsFor(store, target);
  if (handoffs.length === 0) return NOTHING;

  const last = handoffs.reduce((a, b) => (b.card.lastActiveAt > a.card.lastActiveAt ? b : a));
  return `${target}\n\n${agentBrief(last, tz)}`;
}

/** Every context of a day, with what came out of it. The long form, for a report or a timesheet. */
export function dayText(store: Store, day: string | undefined, now: number): string {
  const target = day ?? defaultDay(store, now);
  if (!target) return NOTHING;
  const { handoffs, tz } = handoffsFor(store, target);
  if (handoffs.length === 0) return NOTHING;
  return worklog(target, handoffs, tz);
}

/** The same day, in the shape a standup wants: one line per piece of work. */
export function standupText(store: Store, day: string | undefined, now: number): string {
  const target = day ?? defaultDay(store, now);
  if (!target) return NOTHING;
  const { handoffs } = handoffsFor(store, target);
  if (handoffs.length === 0) return NOTHING;
  return standup(target, handoffs);
}

/**
 * A question in plain language, answered from the stored events.
 *
 * Reads the recent stream across days rather than one day, because a question about last week that
 * only looks at today is not a memory. The refusal is passed through verbatim: REWIND saying it does
 * not know is the answer, and an agent must not be handed a near-miss dressed up as a hit.
 */
export function askText(store: Store, question: string, now: number): string {
  const session = toSession(store.recent(HISTORY_LIMIT), 'history');
  if (session.events.length === 0) return NOTHING;

  const answer = ask(prepare(session), question, now);
  const lines: string[] = [`Question : ${question}`, `Intention : ${answer.intent}`];

  if (answer.refusal) {
    lines.push(
      '',
      `REWIND refuse de répondre (${answer.refusal.reason}). Ce n’est pas une réponse partielle :`,
      'aucune preuve suffisante n’a été trouvée. Ne complète pas cette réponse par une supposition.',
    );
    if (answer.refusal.closest.length > 0) {
      lines.push('', 'Ce qui s’en rapproche, sans être une réponse :');
      for (const scored of answer.refusal.closest.slice(0, 5)) {
        lines.push(`- ${scored.row.label}${scored.row.detail ? ` — ${scored.row.detail}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  if (answer.rollup.length > 0) {
    lines.push('', 'Contextes :');
    for (const context of answer.rollup) {
      const where = [context.place.project, context.place.repository, context.place.branch]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `- ${context.label}${where ? ` (${where})` : ''} — ${context.eventCount} événements`,
      );
    }
  }

  if (answer.results.length > 0) {
    lines.push('', 'Traces :');
    for (const scored of answer.results.slice(0, 10)) {
      const when = new Date(scored.row.lastAt).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(
        `- [${when}] ${scored.row.kind} · ${scored.row.label}${scored.row.detail ? ` — ${scored.row.detail}` : ''}`,
      );
    }
  }

  lines.push(
    '',
    'Répondu par REWIND à partir d’événements enregistrés localement, sans modèle. Chaque ligne',
    'vient d’un événement stocké.',
  );
  return lines.join('\n');
}

/** Which days there is anything to ask about. */
export function daysText(store: Store): string {
  const days = store.days(60);
  if (days.length === 0) return NOTHING;
  return days.map((d) => `${d.day} — ${d.count} événements`).join('\n');
}
