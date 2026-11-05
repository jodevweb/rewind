/**
 * The home screen: where you were, the other projects in play, and one line on the week.
 *
 * It replaced a three-column view that showed the engine's working — contexts, anchors, confidence
 * percentages, unassigned events — to someone who had opened the window to ask one question. That
 * view is still there, behind "Coulisses", for whoever is tuning the engine. This one is for using it.
 *
 * Two rules held it together through several rejected drafts:
 *
 *   - **One large thing, a few small ones.** The project you were on is a large tile with the only
 *     two actions that matter; every other project is a small tile you can promote with a click.
 *   - **Sentences, not figures.** A count appears only when the count is the point ("18 files
 *     waiting"); paths, percentages and Git vocabulary stay out.
 */

import { useMemo, useState, type ReactNode } from 'react';

import '@fontsource-variable/bricolage-grotesque';

import { AgentsSheet, type AgentsApi } from './agents.js';
import { copyText } from './handoff.js';
import { getLocale, t, type Key } from './i18n.js';
import { buildHome, place, projectBrief, PAUSED_AFTER_DAYS, type Project } from './projects.js';
import type { WorkspaceActions } from './workspace.js';
import type { GoldenSession } from '@rewind/fixtures/authoring';
import { workDay } from '@rewind/predict';

const DAY_MS = 86_400_000;

/** One colour per tile position, chosen to stay apart in lightness as well as hue. */
const HUES = ['#4C6FFF', '#E5487F', '#13A37F', '#8B5CF6', '#2BA3D6', '#8A8797'];

/** `{name}`-style holes in a translated string. */
function fill(key: Key, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

function clockAt(ts: number, tz: number): string {
  return new Date(ts + tz * 60_000).toISOString().slice(11, 16);
}

function whenLabel(ts: number, now: number, tz: number): string {
  const day = workDay(ts, tz);
  if (day === workDay(now, tz)) return clockAt(ts, tz);
  if (day === workDay(now - DAY_MS, tz)) return t('home.yesterday');
  return new Intl.DateTimeFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(ts + tz * 60_000));
}

const headlineOf = (p: Project) => p.lastSession?.title ?? p.lastCommit?.message ?? p.name;

const pendingOf = (p: Project) =>
  p.dirty && p.dirty > 0
    ? fill(p.dirty === 1 ? 'home.pending_one' : 'home.pending_other', { n: p.dirty })
    : null;

export function Home({
  history,
  now,
  recording,
  onBackstage,
  actions,
  banners,
  agents,
}: {
  /** Everything the machine holds, across days: projects are only visible across days. */
  history: GoldenSession;
  now: number;
  recording: boolean | null;
  onBackstage: () => void;
  actions?: WorkspaceActions;
  /** Update and permission notices, shown under the header. */
  banners?: ReactNode;
  /** Connecting coding agents. Absent where there is no daemon to do it (the studio). */
  agents?: AgentsApi;
}) {
  const home = useMemo(() => buildHome(history, now), [history, now]);
  const [picked, setPicked] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const colour = useMemo(
    () => new Map(home.projects.map((p, i) => [p.key, HUES[i % HUES.length]!])),
    [home.projects],
  );
  const current = home.projects.find((p) => p.key === picked) ?? home.projects[0];
  const others = home.projects.filter((p) => p !== current);
  const tz = home.tz;

  const dateLabel = new Intl.DateTimeFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(now + tz * 60_000));

  const copy = async (p: Project) => {
    const ok = await copyText(projectBrief(p));
    setFlash(ok ? t('home.copied') : t('handoff.copyFailed'));
    setTimeout(() => setFlash(null), 2000);
  };

  const reopen = (p: Project) => {
    actions?.open?.(p.path);
    p.files.forEach((f) => actions?.open?.(f));
  };

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand">
          <span className="home-word">rewind</span>
          <span className="home-date">{dateLabel}</span>
        </div>
        <div className="home-head-right">
          {recording !== null && (
            <span className="home-rec">
              <span className={`home-dot ${recording ? '' : 'off'}`} aria-hidden />
              {recording ? t('home.recording') : t('home.paused')}
            </span>
          )}
          {agents && (
            <button className="home-link" onClick={() => setAgentsOpen(true)}>
              {t('agents.open')}
            </button>
          )}
          <button className="home-link" onClick={onBackstage}>
            {t('home.backstage')}
          </button>
        </div>
      </header>

      {agents && agentsOpen && <AgentsSheet api={agents} onClose={() => setAgentsOpen(false)} />}

      {banners}

      {!current ? (
        <p className="home-empty">{t('home.empty')}</p>
      ) : (
        <div className={`home-grid others-${others.length}`}>
          <section
            className="home-hero"
            style={{ ['--hue' as string]: colour.get(current.key) }}
            aria-labelledby="home-hero-title"
          >
            <div className="home-hero-text">
              <p className="home-lead">
                {current === home.projects[0]
                  ? fill('home.leftOff', { time: clockAt(current.lastAt, tz), name: current.name })
                  : `${current.name}, ${whenLabel(current.lastAt, now, tz)}`}
              </p>
              <h1 id="home-hero-title">{headlineOf(current)}</h1>
              {current.lastCommit && current.lastSession && (
                <p className="home-did">
                  {fill('home.lastCommit', { msg: current.lastCommit.message })}
                </p>
              )}
              {pendingOf(current) ? (
                <p className="home-warn">{pendingOf(current)}</p>
              ) : now - current.lastAt >= PAUSED_AFTER_DAYS * DAY_MS ? (
                <p className="home-warn">
                  {fill('home.pausedFor', { n: Math.floor((now - current.lastAt) / DAY_MS) })}
                </p>
              ) : null}
            </div>

            <div className="home-hero-foot">
              {home.axis && current.today.length > 0 && (
                <div className="home-band-wrap">
                  <span className="home-band big">
                    {current.today.map((s, i) => {
                      const at = place(s, home.axis!);
                      return (
                        <span
                          key={i}
                          className="home-seg"
                          style={{ left: `${at.left}%`, width: `${at.width}%` }}
                        />
                      );
                    })}
                    <span
                      className="home-now"
                      aria-hidden
                      style={{ left: `${place({ start: now, end: now }, home.axis).left}%` }}
                    />
                  </span>
                  <span className="home-hours" aria-hidden>
                    <span>{clockAt(home.axis.start, tz).slice(0, 2)} h</span>
                    <span>{clockAt(home.axis.end, tz).slice(0, 2)} h</span>
                  </span>
                </div>
              )}
              <div className="home-actions">
                <button className="home-primary" onClick={() => reopen(current)}>
                  {t('home.resume')}
                </button>
                <button className="home-secondary" onClick={() => void copy(current)}>
                  {t('home.copyBrief')}
                </button>
                {flash && <span className="home-flash">{flash}</span>}
              </div>
            </div>
          </section>

          {others.map((p) => {
            const pending = pendingOf(p);
            return (
              <button
                key={p.key}
                className="home-tile"
                style={{ ['--hue' as string]: colour.get(p.key) }}
                onClick={() => setPicked(p.key)}
              >
                <span className="home-tile-top">
                  <span className="home-tile-name">{p.name}</span>
                  <span className={pending ? 'home-tile-warn' : 'home-tile-line'}>
                    {pending
                      ? fill('home.pendingShort', { n: p.dirty ?? 0 })
                      : headlineOf(p) !== p.name
                        ? headlineOf(p)
                        : ''}
                  </span>
                </span>
                {home.axis && p.today.length > 0 ? (
                  <span className="home-band">
                    {p.today.map((s, i) => {
                      const at = place(s, home.axis!);
                      return (
                        <span
                          key={i}
                          className="home-seg"
                          style={{ left: `${at.left}%`, width: `${at.width}%` }}
                        />
                      );
                    })}
                  </span>
                ) : (
                  <span className="home-tile-when">{whenLabel(p.lastAt, now, tz)}</span>
                )}
              </button>
            );
          })}

          <section className="home-week" aria-labelledby="home-week-title">
            <h2 id="home-week-title">{t('home.week')}</h2>
            <p>
              {home.week.length === 0
                ? t('home.week.none')
                : home.week
                    .map((note) =>
                      note.kind === 'main'
                        ? fill('home.week.main', { name: note.name, n: note.days })
                        : note.kind === 'paused'
                          ? fill('home.week.paused', { name: note.name, n: note.days })
                          : fill('home.week.recoveries', { n: note.count }),
                    )
                    .join(' ')}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
