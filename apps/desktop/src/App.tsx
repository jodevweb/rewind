/**
 * REWIND — the desktop window.
 *
 * Deliberately small for the first Rust commit. Its job is to prove the chain end to end: the daemon
 * captures continuously, the tray reflects it, the window shows it, and pause actually stops capture
 * at the source.
 *
 * There is no start button, and there will not be one. Capture runs from launch and the user pauses
 * (§7, §84) — the studio's `pnpm capture` was the wrong model, and this is the correction.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface CaptureStatus {
  recording: boolean;
  pausedUntil: number | null;
  eventsToday: number;
  titleAccess: 'granted' | 'denied' | 'not_required';
  platform: 'macos' | 'windows' | 'other';
}

interface FocusEvent {
  timestamp: number;
  endTimestamp: number | null;
  appId: string;
  appDisplay: string;
  title: string;
  pid: number | null;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const PAUSES: { label: string; minutes: number }[] = [
  { label: '5 min', minutes: 5 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: "Jusqu'à reprise", minutes: 0 },
];

export function App() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [events, setEvents] = useState<FocusEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        invoke<CaptureStatus>('capture_status'),
        invoke<FocusEvent[]>('recent_events', { limit: 60 }),
      ]);
      setStatus(s);
      setEvents(e);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const setPaused = async (minutes: number | null) => {
    const next = await invoke<CaptureStatus>('set_paused', { minutes });
    setStatus(next);
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className={`dot ${status?.recording ? 'on' : 'off'}`} aria-hidden />
          <span className="wordmark">REWIND</span>
        </div>

        <span className="state">
          {status?.recording
            ? 'Enregistrement'
            : status?.pausedUntil
              ? `En pause jusqu'à ${clock(status.pausedUntil)}`
              : 'En pause'}
        </span>

        <div className="spacer" />

        <span className="count">{status?.eventsToday ?? 0} événements</span>

        <div className="pauses">
          {status?.recording ? (
            PAUSES.map((p) => (
              <button key={p.minutes} onClick={() => void setPaused(p.minutes)}>
                {p.label}
              </button>
            ))
          ) : (
            <button className="primary" onClick={() => void setPaused(null)}>
              Reprendre
            </button>
          )}
        </div>
      </header>

      {/* macOS cannot read window titles without Accessibility. Saying so is the whole of ADR 0003
          D-22's degraded mode: never pretend the capture is as good as it would be. */}
      {status?.titleAccess === 'denied' && (
        <div className="warn">
          <strong>Accessibility n’est pas accordée.</strong> REWIND voit quelle application est
          active mais pas le titre de ses fenêtres — et le titre est l’essentiel du signal. Réglages
          Système → Confidentialité et sécurité → Accessibilité. REWIND ne prend aucune capture
          d’écran et ne demande jamais l’enregistrement d’écran.
        </div>
      )}

      {error && <div className="warn">{error}</div>}

      <main>
        {events.length === 0 ? (
          <p className="empty">
            REWIND apprend ton travail. Utilise ta machine normalement — les premiers événements
            apparaissent ici en quelques secondes.
          </p>
        ) : (
          <ul className="events">
            {events.map((e, i) => (
              <li key={`${e.timestamp}-${i}`}>
                <span className="at">{clock(e.timestamp)}</span>
                <span className="app">{e.appDisplay}</span>
                <span className="title">{e.title || <em>sans titre</em>}</span>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer>
        {status?.platform === 'macos' ? 'macOS' : status?.platform === 'windows' ? 'Windows' : '—'}{' '}
        · tout reste sur cette machine
      </footer>
    </div>
  );
}
