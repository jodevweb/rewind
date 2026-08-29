/**
 * REWIND — the desktop window.
 *
 * The same interface the studio renders, on real events from the daemon. It was a bare event list
 * for one commit while the real interface lived only in the studio; that gap is closed.
 *
 * There is no start button and there will not be one. Capture runs from launch and you pause it
 * (§7, §84).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';

import type { GoldenSession } from '@rewind/fixtures/authoring';
import {
  getLocale,
  setLocale,
  t,
  tPlural,
  Workspace,
  type Locale,
  type WorkspaceActions,
} from '@rewind/ui';
import { runEngine } from '@rewind/engine-v0';
import { workDay } from '@rewind/predict';
import '@rewind/ui/styles.css';

interface CaptureStatus {
  recording: boolean;
  pausedUntil: number | null;
  eventsToday: number;
  eventsTotal: number;
  titleAccess: 'granted' | 'denied' | 'not_required';
  platform: 'macos' | 'windows' | 'other';
  /** Where the events actually live. Shown so it is never a mystery (PRIVACY §12). */
  storePath: string;
  diagnostics: string;
}

/** One work day that has events in it. Counted by the daemon in SQL, never by loading the day. */
interface DaySummary {
  day: string;
  count: number;
  first: number;
  last: number;
}

interface DaemonEvent {
  timestamp: number;
  endTimestamp: number | null;
  tzOffsetMinutes: number;
  source: string;
  type: string;
  appId: string;
  appDisplay: string;
  title: string;
  pid: number | null;
  /** JSON. Opaque to the daemon, meaningful to the engine — anchors live in here. */
  metadata: string;
  redactionVersion: string;
  redactionApplied: string[];
  redactionCount: number;
  importance: number;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const PAUSES = [
  { label: '5 min', minutes: 5 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: "Jusqu'à reprise", minutes: 0 },
];

/**
 * Adapt the daemon's focus events into the session shape the engine consumes.
 *
 * The daemon speaks a narrow struct; the engine speaks the event model. Converting here rather than
 * widening either keeps the daemon small and the engine platform-agnostic — and it is the seam the
 * Rust port replaces, since the engine will eventually consume these events directly.
 */
function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toSession(events: DaemonEvent[], id = 'live'): GoldenSession {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  // The offset the events were captured at, not the one this machine is in now. A day looked at
  // from another timezone must read as the day it was, at the hours it happened (TR-8).
  const tz = ordered[0]?.tzOffsetMinutes ?? -new Date().getTimezoneOffset();
  return {
    id,
    name: 'Aujourd’hui',
    description: 'Activité capturée sur cette machine.',
    tests: '',
    day: new Date().toISOString().slice(0, 10),
    tzOffsetMinutes: tz,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events: ordered.map((e, i) => ({
      id: `${id}-${i}`,
      ref: `${id}-${String(i).padStart(5, '0')}`,
      timestamp: e.timestamp,
      ...(e.endTimestamp !== null ? { endTimestamp: e.endTimestamp } : {}),
      tzOffsetMinutes: e.tzOffsetMinutes,
      source: e.source as 'system',
      type: e.type,
      producer: { name: 'rewind-daemon', version: '0.1.0' },
      app: e.appId,
      appDisplay: e.appDisplay,
      title: e.title,
      metadata: {
        bundleId: e.appId,
        ...(e.pid !== null ? { pid: e.pid } : {}),
        // The daemon keeps the payload opaque; parsing it here is what turns a Claude session into
        // anchors the engine can group on. A malformed payload must not take the timeline with it.
        ...parseMetadata(e.metadata),
      },
      privacyLevel: 'normal' as const,
      redaction: {
        patternsVersion: e.redactionVersion,
        applied: e.redactionApplied,
        count: e.redactionCount,
      },
      importance: e.importance,
    })),
  };
}

export function App() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  /**
   * The day on screen, and everything the daemon has.
   *
   * Two queries rather than one, because they answer different questions. `dayEvents` is the day
   * being read and is the only thing the engine sees — handing it a fortnight would let last
   * Tuesday's anchors compete with this morning's. `history` is the recent stream across days, and
   * exists for the prediction layer, which counts habits and cannot see one from a single day.
   */
  const [dayEvents, setDayEvents] = useState<DaemonEvent[]>([]);
  const [history, setHistory] = useState<DaemonEvent[]>([]);
  const [days, setDays] = useState<DaySummary[]>([]);
  /** `null` means the live day, and keeps following the clock past midnight. */
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [version, setVersion] = useState('');
  /**
   * What the last update check did.
   *
   * It used to swallow every failure, on the reasoning that no network and no release yet are both
   * normal. That reasoning is right and the conclusion was wrong: it also swallowed a permission
   * error that made the check fail every single time, and an application that never finds an update
   * looks exactly like one that is up to date. Whatever happened is now written down and shown.
   */
  const [checkState, setCheckState] = useState<
    | { status: 'never' | 'checking' | 'clean' | 'found'; at?: number }
    | { status: 'error'; reason: string }
  >({ status: 'never' });

  const today = workDay(Date.now(), -new Date().getTimezoneOffset());
  const activeDay = pickedDay ?? today;
  const isLiveDay = activeDay === today;

  const refresh = useCallback(async () => {
    try {
      const [s, d, e] = await Promise.all([
        invoke<CaptureStatus>('capture_status'),
        invoke<DaySummary[]>('event_days'),
        invoke<DaemonEvent[]>('events_for_day', { day: activeDay }),
      ]);
      setStatus(s);
      setDays(d);
      setDayEvents(e);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [activeDay]);

  useEffect(() => {
    void refresh();
    // Only the live day changes while you look at it. A day from last month is finished, and
    // re-reading it every three seconds is work nobody asked for.
    if (!isLiveDay) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh, isLiveDay]);

  // History moves on the scale of days, so it is read on the scale of minutes.
  useEffect(() => {
    const load = () =>
      invoke<DaemonEvent[]>('recent_events', { limit: 20000 })
        .then(setHistory)
        .catch(() => {});
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Offered, never applied on its own: an application that restarts itself while you are working is
  // a worse problem than a stale version.
  const checkNow = useCallback(async () => {
    setCheckState({ status: 'checking' });
    try {
      const found = await checkForUpdate();
      setUpdate(found ?? null);
      setCheckState({ status: found ? 'found' : 'clean', at: Date.now() });
    } catch (err) {
      setCheckState({ status: 'error', reason: String(err) });
    }
  }, []);

  useEffect(() => {
    void checkNow();
    const timer = setInterval(() => void checkNow(), 3_600_000);
    return () => clearInterval(timer);
  }, [checkNow]);

  // The running version, so "am I on the new one?" is answerable by looking.
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  const applyUpdate = async () => {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setUpdating(false);
    }
  };

  const session = useMemo(() => toSession(dayEvents, activeDay), [dayEvents, activeDay]);
  const historySession = useMemo(() => toSession(history, 'history'), [history]);
  const contextCount = useMemo(
    () => (session.events.length > 0 ? runEngine(session).contexts.length : 0),
    [session],
  );

  /**
   * The clock the view reasons from.
   *
   * On a past day it is that day's last moment, not now. Otherwise every context reads as hours
   * stale, the drift panel announces that you have moved on from work you finished in March, and
   * "recently" means nothing on a day that ended six months ago.
   */
  const viewClock = isLiveDay
    ? Date.now()
    : (days.find((d) => d.day === activeDay)?.last ?? Date.now());

  // Opening is what makes the interface an explorer rather than a log. The daemon does the opening:
  // it is the only side that can check the target is a real path or an http(s) URL before handing it
  // to the system, and it never goes through a shell.
  const actions: WorkspaceActions = useMemo(
    () => ({
      open: (target) => void invoke('open_target', { target }).catch(setError),
      reveal: (target) => void invoke('reveal_target', { target }).catch(setError),
    }),
    [],
  );

  const setPaused = async (minutes: number | null) => {
    setStatus(await invoke<CaptureStatus>('set_paused', { minutes }));
  };

  const switchLocale = (next: Locale) => {
    setLocale(next);
    forceRender((n) => n + 1);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`pulse ${status?.recording ? '' : 'paused'}`} aria-hidden />
          <span className="wordmark">REWIND</span>
          {version && <span className="version">{version}</span>}
          <span className="sub">
            {status?.recording
              ? t('app.recording')
              : status?.pausedUntil
                ? `${t('app.pausedUntil')} ${clock(status.pausedUntil)}`
                : t('app.paused')}
          </span>
        </div>

        <div className="pauses">
          {status?.recording ? (
            PAUSES.map((p) => (
              <button key={p.minutes} onClick={() => void setPaused(p.minutes)}>
                {p.label}
              </button>
            ))
          ) : (
            <button className="primary" onClick={() => void setPaused(null)}>
              {t('app.resume')}
            </button>
          )}
        </div>

        <div className="spacer" />

        <div className="stat" title={status?.storePath ?? ''}>
          <b>{session.events.length}</b> {t('header.events')}
          <span className="arrow">→</span>
          <b>{contextCount}</b> {tPlural('header.contexts', contextCount)}
          {status && status.eventsTotal > status.eventsToday && (
            <span className="total">
              · {status.eventsTotal} {t('header.kept')}
            </span>
          )}
        </div>

        <button
          className="ghost"
          disabled={checkState.status === 'checking'}
          onClick={() => void checkNow()}
        >
          {checkState.status === 'checking' ? t('update.checking') : t('update.check')}
        </button>

        <div className="locale">
          {(['fr', 'en'] as Locale[]).map((l) => (
            <button
              key={l}
              className={getLocale() === l ? 'on' : ''}
              onClick={() => switchLocale(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {/* macOS cannot read window titles without Accessibility, and the titles are most of the
          signal. Say so rather than pretending the capture is as good (ADR 0003 D-22). */}
      {status?.titleAccess === 'denied' && (
        <div className="banner warn">
          <strong>{t('perm.title')}</strong> {t('perm.body')}
        </div>
      )}

      {update && (
        <div className="banner update">
          <strong>
            {t('update.available')} {update.version}
          </strong>{' '}
          {(update.body ?? '').split(/\r?\n/)[0]}
          <button className="ghost" disabled={updating} onClick={() => void applyUpdate()}>
            {updating ? t('update.installing') : t('update.install')}
          </button>
        </div>
      )}

      {error && <div className="banner warn">{error}</div>}

      <DayStrip
        days={days}
        active={activeDay}
        today={today}
        onPick={(day) => setPickedDay(day === today ? null : day)}
      />

      <Workspace
        session={session}
        history={historySession}
        now={viewClock}
        heading={isLiveDay ? undefined : formatDay(activeDay)}
        onDay={(day) => setPickedDay(day === today ? null : day)}
        emptyMessage={t('app.empty')}
        actions={actions}
      />

      {status && (
        <footer className="diag">
          <span>{status.platform}</span>
          <span>·</span>
          <span>
            {t('diag.titles')} {t(`diag.${status.titleAccess}` as 'diag.granted')}
          </span>
          {status.diagnostics && (
            <>
              <span>·</span>
              <span className="mono">{status.diagnostics}</span>
            </>
          )}
          <span>·</span>
          <span className="mono" title={status.storePath}>
            {status.eventsTotal} {t('header.kept')}
          </span>
          <span>·</span>
          <span className={checkState.status === 'error' ? 'diag-bad' : undefined}>
            {checkState.status === 'error'
              ? `${t('update.failed')} ${checkState.reason}`
              : checkState.status === 'checking'
                ? t('update.checking')
                : checkState.status === 'never'
                  ? t('update.never')
                  : `${checkState.status === 'found' ? '' : `${t('update.upToDate')} · `}${t('update.lastCheck')} ${clock(checkState.at ?? Date.now())}`}
          </span>
        </footer>
      )}
    </div>
  );
}

/** `2026-03-12` as "jeu. 12 mars", in the reader's language. */
function formatDay(day: string): string {
  // Noon, so no timezone can push the label onto the day before or after.
  const at = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * Every day there is something to read, newest first.
 *
 * The promise is that you can come back six months later, and until now the application could only
 * show you the hours it happened to have loaded. The bars are the day's event count against the
 * busiest day on screen: not a score and not a target — a shape, so a fortnight of work is
 * navigable by recognising it rather than by reading fourteen dates.
 */
function DayStrip({
  days,
  active,
  today,
  onPick,
}: {
  days: DaySummary[];
  active: string;
  today: string;
  onPick: (day: string) => void;
}) {
  if (days.length < 2) return null;
  const peak = Math.max(...days.map((d) => d.count), 1);

  return (
    <nav className="daystrip">
      {days.map((d) => (
        <button
          key={d.day}
          className={`day ${d.day === active ? 'on' : ''}`}
          onClick={() => onPick(d.day)}
          title={`${d.count} ${t('header.events')}`}
        >
          <span className="day-label">{d.day === today ? t('days.today') : formatDay(d.day)}</span>
          <span className="day-track" aria-hidden>
            <span
              className="day-bar"
              style={{ height: `${Math.max(8, Math.round((d.count / peak) * 100))}%` }}
            />
          </span>
        </button>
      ))}
    </nav>
  );
}
