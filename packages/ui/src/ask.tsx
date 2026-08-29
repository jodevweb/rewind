/**
 * Ask — the command bar.
 *
 * The README promises that you can come back six months later and ask *what was I working on*,
 * *where was that page*, *why did I touch this file*. Until this file existed, the application had
 * no way to be asked anything: it showed you the day it had reconstructed and left you to scroll.
 * That is the difference between a log and a memory.
 *
 * Three decisions worth keeping:
 *
 *   - **It answers as you type**, because the whole pipeline is local arithmetic over rows already
 *     in memory. There is no request to wait for, so there is no reason to make anyone press Enter
 *     before showing them what is there.
 *   - **It shows its reasoning** — the intent it read, the window it resolved, the terms it actually
 *     searched for. A reader who can see why an answer is wrong can fix the question. A reader who
 *     cannot see it concludes the tool is broken.
 *   - **It shows a refusal as a refusal.** The closest matches appear *under* the admission that
 *     nothing cleared the bar, never in place of it.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import {
  ask,
  prepare,
  type Answer,
  type Intent,
  type RowKind,
  type Rollup,
  type Scored,
  type TimeWindow,
} from '@rewind/ask';
import type { GoldenSession } from '@rewind/fixtures/authoring';

import { formatDuration, getLocale, t, type Key } from './i18n.js';

const GLYPHS: Record<RowKind, string> = {
  url: '◍',
  file: '▤',
  command: '▸',
  commit: '◈',
  agent: '✳',
  note: '✎',
  error: '✕',
  window: '▢',
};

const INTENT_KEYS: Record<Intent, Key> = {
  resume: 'ask.intent.resume',
  temporal: 'ask.intent.temporal',
  retrieval: 'ask.intent.retrieval',
  causal: 'ask.intent.causal',
  summary: 'ask.intent.summary',
  navigation: 'ask.intent.navigation',
  comparison: 'ask.intent.comparison',
};

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

/**
 * The resolved window, in the reader's language and in the timezone the events were captured in.
 *
 * Shifted then formatted as UTC: the alternative is `Intl` helpfully re-interpreting the instant in
 * the machine's current zone, which is the one thing TR-8 says must never happen.
 */
function formatWindow(window: TimeWindow, tz: number): string {
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-GB';
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const from = new Date(window.from + tz * 60_000);
  // Half-open: a window ending at exactly 04:00 belongs to the day before, and labelling it with the
  // next morning's date reads as a day nobody asked about.
  const to = new Date(window.to + tz * 60_000 - 1);
  const sameDay = from.toISOString().slice(0, 10) === to.toISOString().slice(0, 10);
  const hours = `${from.toISOString().slice(11, 16)} → ${to.toISOString().slice(11, 16)}`;
  return sameDay ? `${date.format(from)} · ${hours}` : `${date.format(from)} → ${date.format(to)}`;
}

/** Matched terms, marked in the row's own text. */
function Highlight({ text, matched }: { text: string; matched: string[] }) {
  if (matched.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `(${matched.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  return (
    <>
      {text
        .split(pattern)
        .map((part, i) =>
          matched.some((m) => m.toLowerCase() === part.toLowerCase()) ? (
            <mark key={i}>{part}</mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </>
  );
}

export interface AskHandlers {
  /** Bring a context to the front of the workspace. */
  onContext: (contextId: string) => void;
  /** Open the timeline at one exact moment. */
  onMoment: (contextId: string | null, eventRef: string) => void;
  /** Hand a path or URL to the system. */
  onOpen?: (target: string) => void;
}

/**
 * Everything selectable in the palette, flattened.
 *
 * Rows and contexts are one list rather than two so that the arrow keys traverse what is on screen
 * in the order it is on screen. Two lists with two cursors is the kind of detail that makes a
 * palette feel like a form.
 */
type Choice = { kind: 'row'; scored: Scored } | { kind: 'context'; rollup: Rollup };

function choicesOf(answer: Answer): Choice[] {
  const contexts: Choice[] =
    answer.intent === 'temporal' || answer.intent === 'summary' || answer.intent === 'resume'
      ? answer.rollup.slice(0, 6).map((rollup) => ({ kind: 'context' as const, rollup }))
      : [];
  const rows: Choice[] = answer.results.map((scored) => ({ kind: 'row' as const, scored }));
  return [...contexts, ...rows];
}

export function Ask({
  session,
  handlers,
  now,
}: {
  session: GoldenSession;
  handlers: AskHandlers;
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Cmd-K on macOS, Ctrl-K everywhere else. Bound on the window rather than on a container because
  // the point of a command bar is that it opens from wherever you are.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <>
      <button className="ask-trigger" onClick={() => setOpen(true)}>
        <span className="ask-glyph" aria-hidden>
          ⌕
        </span>
        <span className="ask-trigger-text">{t('ask.placeholder')}</span>
        <kbd>⌘K</kbd>
      </button>

      {open && (
        <div className="ask-scrim" onClick={() => setOpen(false)}>
          <div className="ask-panel" onClick={(e) => e.stopPropagation()}>
            <AskPanel
              session={session}
              query={query}
              setQuery={(next) => {
                setQuery(next);
                setCursor(0);
              }}
              cursor={cursor}
              setCursor={setCursor}
              inputRef={input}
              handlers={handlers}
              close={() => setOpen(false)}
              now={now}
            />
          </div>
        </div>
      )}
    </>
  );
}

function AskPanel({
  session,
  query,
  setQuery,
  cursor,
  setCursor,
  inputRef,
  handlers,
  close,
  now,
}: {
  session: GoldenSession;
  query: string;
  setQuery: (next: string) => void;
  cursor: number;
  setCursor: (next: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  handlers: AskHandlers;
  close: () => void;
  now?: number;
}) {
  // Built once per session, and only once the palette is open — folding a day into rows costs an
  // engine run, and paying it on launch for a feature nobody has opened yet is how a local-first
  // application ends up feeling slower than a hosted one.
  const corpus = useMemo(() => prepare(session), [session]);
  const wallClock = now ?? Date.now();
  const answer = useMemo(
    () => (query.trim() === '' ? null : ask(corpus, query, wallClock)),
    [corpus, query, wallClock],
  );

  const choices = useMemo(() => (answer ? choicesOf(answer) : []), [answer]);
  const tz = corpus.tzOffsetMinutes;

  const choose = (choice: Choice | undefined) => {
    if (!choice) return;
    if (choice.kind === 'context') handlers.onContext(choice.rollup.contextId);
    else handlers.onMoment(choice.scored.row.contextId, choice.scored.row.evidence[0]!);
    close();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(Math.min(cursor + 1, choices.length - 1));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(cursor - 1, 0));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const choice = choices[cursor];
      // Cmd-Enter opens the thing itself; Enter goes to the moment it happened. Opening is the
      // destructive-ish one — it launches an application — so it is the one that needs a modifier.
      if ((e.metaKey || e.ctrlKey) && choice?.kind === 'row' && choice.scored.row.target) {
        handlers.onOpen?.(choice.scored.row.target);
        close();
        return;
      }
      choose(choice);
    }
  };

  return (
    <>
      <div className="ask-field">
        <span className="ask-glyph" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          value={query}
          placeholder={t('ask.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
      </div>

      {!answer && <Examples onPick={setQuery} />}

      {answer && (
        <>
          <div className="ask-chips">
            <span className="chip solid">{t(INTENT_KEYS[answer.intent])}</span>
            {answer.window && (
              <span className={`chip ${answer.window.hard ? '' : 'soft'}`}>
                {formatWindow(answer.window, tz)}
                <em>{answer.window.expression}</em>
              </span>
            )}
            {answer.window?.ambiguous && <span className="chip warn">{t('ask.ambiguous')}</span>}
            {answer.terms.map((term) => (
              <span className="chip" key={term}>
                {term}
              </span>
            ))}
          </div>

          {answer.refusal ? (
            <div className="ask-refusal">
              <p className="ask-refusal-head">{t(`ask.refusal.${answer.refusal.reason}`)}</p>
              {answer.refusal.closest.length > 0 && (
                <>
                  <div className="eyebrow">{t('ask.closest')}</div>
                  <ul className="ask-list">
                    {answer.refusal.closest.map((scored) => (
                      <li key={scored.row.key}>
                        <RowLine scored={scored} tz={tz} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="footnote">{t('ask.refusal.hint')}</p>
            </div>
          ) : (
            <ul className="ask-list">
              {choices.map((choice, i) => (
                <li
                  key={choice.kind === 'row' ? choice.scored.row.key : choice.rollup.contextId}
                  className={i === cursor ? 'on' : ''}
                >
                  <button
                    className="ask-row"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(choice)}
                  >
                    {choice.kind === 'context' ? (
                      <ContextLine rollup={choice.rollup} tz={tz} />
                    ) : (
                      <RowLine scored={choice.scored} tz={tz} />
                    )}
                  </button>
                  {choice.kind === 'row' && choice.scored.row.target && handlers.onOpen && (
                    <button
                      className="cite"
                      onClick={() => {
                        handlers.onOpen?.(choice.scored.row.target!);
                        close();
                      }}
                    >
                      {t('ask.open')}
                    </button>
                  )}
                </li>
              ))}
              {choices.length === 0 && <li className="noise">{t('ask.nothing')}</li>}
            </ul>
          )}
        </>
      )}

      <p className="ask-foot">{t('ask.foot')}</p>
    </>
  );
}

function RowLine({ scored, tz }: { scored: Scored; tz: number }) {
  const { row, matched } = scored;
  const span =
    row.occurrences > 1
      ? `${clock(row.firstAt, tz)} → ${clock(row.lastAt, tz)}`
      : clock(row.lastAt, tz);
  return (
    <>
      <span className="ask-dot" title={row.kind}>
        {GLYPHS[row.kind]}
      </span>
      <span className="ask-main">
        <span className="ask-label">
          <Highlight text={row.label} matched={matched} />
        </span>
        {row.detail && (
          <span className="ask-detail mono">
            <Highlight text={row.detail} matched={matched} />
          </span>
        )}
      </span>
      <span className="ask-meta">
        {row.contextLabel && <span className="ask-ctx">{row.contextLabel}</span>}
        <span className="ask-when">
          {span}
          {row.occurrences > 1 && <b> ×{row.occurrences}</b>}
        </span>
      </span>
    </>
  );
}

function ContextLine({ rollup, tz }: { rollup: Rollup; tz: number }) {
  const place = [rollup.place.project, rollup.place.repository, rollup.place.branch]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <span className="ask-dot" aria-hidden>
        ◆
      </span>
      <span className="ask-main">
        <span className="ask-label">
          {rollup.labelIsFallback ? `${t('today.fallbackLabel')} ${rollup.label}` : rollup.label}
        </span>
        <span className="ask-detail">
          {place && <span className="mono">{place}</span>}
          {rollup.highlights.slice(0, 3).map((row) => (
            <span className="ask-hint" key={row.key}>
              {GLYPHS[row.kind]} {row.label}
            </span>
          ))}
        </span>
      </span>
      <span className="ask-meta">
        <span className="ask-ctx">{formatDuration(rollup.activeMs)}</span>
        <span className="ask-when">
          {clock(rollup.startTimestamp, tz)} → {clock(rollup.endTimestamp, tz)}
        </span>
      </span>
    </>
  );
}

/**
 * What to type, when the box is empty.
 *
 * An empty command bar is a blank page, and a blank page in a product nobody has used before is a
 * dead end. These are the four question shapes the resolver actually handles well, so they double as
 * documentation of what it can do.
 */
function Examples({ onPick }: { onPick: (query: string) => void }) {
  const keys = ['ask.example1', 'ask.example2', 'ask.example3', 'ask.example4'] as const;
  return (
    <div className="ask-examples">
      <div className="eyebrow">{t('ask.examples')}</div>
      {keys.map((key) => (
        <button key={key} className="ask-example" onClick={() => onPick(t(key))}>
          {t(key)}
        </button>
      ))}
    </div>
  );
}
