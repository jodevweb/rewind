/**
 * The product's interface: Today, Resume, Timeline.
 *
 * Shared by the desktop application and the studio. It lived only in the studio for a while, which
 * is how the application ended up with a window that looked nothing like the thing being designed —
 * there were two interfaces and only one of them was the product.
 *
 * Input is a session: events plus optional ground truth. The desktop app builds one from the events
 * the daemon captured; the studio passes a golden fixture. Neither knows anything the other does not.
 *
 * The engine here is `@rewind/engine-v0`, the TypeScript reference implementation. ADR 0001 D-4 puts
 * the production engine in Rust; running it in the view is the interim that lets the real interface
 * exist on real data now, and it is a known port, not a hidden one.
 */

import { useMemo, useState, type ReactNode } from 'react';

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import {
  buildResume,
  runEngine,
  strength,
  type Activity,
  type EngineContext,
  type NextStep,
} from '@rewind/engine-v0';

import { formatDuration, t, tPlural } from './i18n.js';

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

/**
 * Source identity as restrained colour. §143 preferred monochrome glyphs, but over a dense timeline
 * a single accent proved hard to scan. One muted hue per source — muted being the operative word,
 * since this must not become a rainbow dashboard (§142).
 */
export const SOURCES: Record<string, { glyph: string; label: string }> = {
  system: { glyph: '▢', label: 'Système' },
  browser: { glyph: '◍', label: 'Navigateur' },
  ide: { glyph: '◆', label: 'Éditeur' },
  filesystem: { glyph: '▤', label: 'Fichiers' },
  git: { glyph: '◈', label: 'Git' },
  terminal: { glyph: '▸', label: 'Terminal' },
  agent: { glyph: '✳', label: 'Agent' },
  external: { glyph: '⬢', label: 'Cockpit' },
  manual: { glyph: '✎', label: 'Note' },
};

const meta = (e: GoldenEvent) => e.metadata as Record<string, unknown>;
const str = (e: GoldenEvent, k: string) =>
  typeof meta(e)[k] === 'string' ? (meta(e)[k] as string) : undefined;
const leaf = (p: string | undefined) => (p ?? '').split(/[/\\]/).filter(Boolean).pop() ?? '';

export function headline(e: GoldenEvent): string {
  const m = meta(e);
  switch (e.type) {
    case 'terminal.command':
      return str(e, 'commandRedacted') ?? 'commande';
    case 'terminal.error_tail':
      return Array.isArray(m['lines']) ? String((m['lines'] as unknown[])[0]) : 'erreur';
    case 'git.commit':
      return str(e, 'messageRedacted') ?? 'commit';
    case 'git.branch.checkout':
      return `checkout ${str(e, 'to') ?? ''}`;
    case 'git.status.summary':
      return `${m['dirtyFiles'] ?? 0} fichier(s) non commités · ${str(e, 'branch') ?? ''}`;
    case 'git.repo.detected':
      return `dépôt détecté · ${leaf(str(e, 'path'))}`;
    case 'git.stash':
      return `stash · ${str(e, 'target') ?? ''}`;
    case 'manual.note':
      return str(e, 'text') ?? '';
    case 'ide.file.saved':
    case 'ide.file.opened':
      return leaf(str(e, 'path'));
    case 'ide.workspace.opened':
      return leaf(str(e, 'workspacePath'));
    case 'ide.diagnostic.error':
      return str(e, 'messageRedacted') ?? 'erreur';
    case 'fs.batch':
      return `${m['count'] ?? 0} modifications de fichiers`;
    case 'fs.file.created':
    case 'fs.file.modified':
      return leaf(str(e, 'path'));
    case 'fs.file.renamed':
      return `${leaf(str(e, 'fromPath'))} → ${leaf(str(e, 'toPath'))}`;
    case 'agent.session.started':
      return 'session Claude Code démarrée';
    case 'agent.activity':
      return `Claude Code — ${m['toolCallCount'] ?? 0} appels d’outils`;
    case 'external.mission.started':
      return `mission : ${str(e, 'mission') ?? ''}`;
    case 'external.run.finished':
      return `run ${str(e, 'runId') ?? ''} — ${str(e, 'status') ?? ''}`;
    case 'external.agent.started':
      return `agent ${str(e, 'agent') ?? ''} démarré`;
    case 'system.window.title_changed':
      return e.title ?? '';
    default:
      return e.title ?? e.type;
  }
}

const isFailure = (e: GoldenEvent) =>
  (e.type === 'terminal.command' && meta(e)['exitCode'] !== 0) ||
  e.type === 'terminal.error_tail' ||
  e.type === 'ide.diagnostic.error';

const isWin = (e: GoldenEvent) =>
  e.type === 'git.commit' ||
  (e.type === 'terminal.command' && meta(e)['exitCode'] === 0) ||
  (e.type === 'external.run.finished' && str(e, 'status') === 'succeeded');

export function Workspace({
  session,
  aside,
  emptyMessage,
}: {
  session: GoldenSession;
  /** Studio-only extras, such as the ground-truth panel. */
  aside?: ReactNode;
  emptyMessage?: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [citation, setCitation] = useState<string | null>(null);

  const result = useMemo(() => runEngine(session), [session]);
  const byRef = useMemo(() => new Map(session.events.map((e) => [e.ref, e])), [session]);

  const active = result.contexts.find((c) => c.id === selected) ?? result.contexts[0];
  const resume = useMemo(() => (active ? buildResume(session, active) : null), [session, active]);
  const tz = session.tzOffsetMinutes;

  if (session.events.length === 0 && emptyMessage) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <main>
      <section className="col">
        <h2>{t('today.title')}</h2>
        <p className="hint">{t('today.hint')}</p>
        {result.contexts.map((c, i) => (
          <ContextCard
            key={c.id}
            context={c}
            hue={i}
            isActive={active?.id === c.id}
            onSelect={() => setSelected(c.id)}
          />
        ))}
        {result.contexts.length === 0 && <p className="noise">{t('today.none')}</p>}
        {result.unassigned.length > 0 && (
          <LoosePanel refs={result.unassigned} byRef={byRef} tz={tz} />
        )}
        {aside}
      </section>

      <section className="col">
        <h2>{t('resume.title')}</h2>
        {resume && active ? (
          <div className="card resume">
            <div className="eyebrow">{t('resume.wasWorkingOn')}</div>
            <h3>{resume.contextLabel}</h3>
            <div className="submeta">
              {t('resume.lastActivity')} {clock(resume.lastActiveAt, tz)} ·{' '}
              <b>{formatDuration(resume.activeMs)}</b> {t('resume.active')}
            </div>
            <AppChain apps={resume.appChain} />

            <Rows label={t('resume.files')} lines={resume.working} tz={tz} onCite={setCitation} />
            <Rows label={t('resume.reading')} lines={resume.reading} tz={tz} onCite={setCitation} />
            <Rows label={t('resume.ran')} lines={resume.ran} tz={tz} onCite={setCitation} />
            <Rows label={t('resume.failed')} lines={resume.failures} tz={tz} onCite={setCitation} />
            <Rows
              label={t('resume.produced')}
              lines={resume.produced}
              tz={tz}
              onCite={setCitation}
            />

            {resume.nextStep && (
              <div className="next">
                <div className="eyebrow">{t('resume.nextStep')}</div>
                <p>{renderNextStep(resume.nextStep)}</p>
                <button className="cite" onClick={() => setCitation(resume.nextStep!.evidenceRef)}>
                  {t('resume.evidence')}
                </button>
              </div>
            )}

            <div className="actions">
              {resume.openResources.slice(0, 4).map((r, i) => (
                <button key={i} className="ghost" title={r.target}>
                  {t('resume.open')} {t(`openKind.${r.kind}` as 'openKind.url')}
                </button>
              ))}
            </div>
            <p className="footnote">{t('resume.footnote')}</p>
          </div>
        ) : (
          <div className="card empty">{t('resume.none')}</div>
        )}

        {active && <Anchors context={active} />}
      </section>

      <section className="col">
        <h2>{t('timeline.title')}</h2>
        {active && (
          <Timeline
            context={active}
            activities={result.activities}
            byRef={byRef}
            tz={tz}
            citation={citation}
          />
        )}
      </section>
    </main>
  );
}

/**
 * Events are grouped into the activities the engine produced, on a continuous rail — the structure
 * §50 specifies. An earlier version rendered raw events, so a session read as a log rather than work.
 */
function Timeline({
  context,
  activities,
  byRef,
  tz,
  citation,
}: {
  context: EngineContext;
  activities: Activity[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
  citation: string | null;
}) {
  const inContext = new Set(context.eventRefs);
  const blocks = activities
    .map((a) => ({
      activity: a,
      events: a.eventRefs
        .filter((r) => inContext.has(r))
        .map((r) => byRef.get(r))
        .filter((e): e is GoldenEvent => Boolean(e))
        .sort((x, y) => x.timestamp - y.timestamp),
    }))
    .filter((b) => b.events.length > 0)
    .sort((x, y) => x.events[0]!.timestamp - y.events[0]!.timestamp);

  return (
    <div className="timeline">
      {blocks.map((b) => {
        const first = b.events[0]!;
        const last = b.events[b.events.length - 1]!;
        const span = (last.endTimestamp ?? last.timestamp) - first.timestamp;
        return (
          <div className="tl-block" key={b.activity.id}>
            <div className="tl-gutter">
              <span className="tl-time">{clock(first.timestamp, tz)}</span>
              <span className="tl-rail" aria-hidden />
            </div>
            <div className="tl-body">
              <div className="tl-head">
                {b.activity.apps.map((app) => (
                  <span className="chip" key={app}>
                    {app}
                  </span>
                ))}
                {span >= 60_000 && <span className="tl-span">{formatDuration(span)}</span>}
              </div>
              <ul className="tl-events">
                {b.events.map((e) => {
                  const src = SOURCES[e.source] ?? { glyph: '·', label: e.source };
                  return (
                    <li
                      key={e.ref}
                      className={[
                        `src-${e.source}`,
                        isFailure(e) ? 'fail' : '',
                        isWin(e) ? 'win' : '',
                        citation === e.ref ? 'cited' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span className="tl-dot" title={src.label}>
                        {src.glyph}
                      </span>
                      <span className="tl-at">{clock(e.timestamp, tz)}</span>
                      <span className="tl-text">{headline(e)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AppChain({ apps }: { apps: string[] }) {
  return (
    <div className="chain">
      {apps.map((a, i) => (
        <span className="chain-item" key={a}>
          <span className="chip solid">{a}</span>
          {i < apps.length - 1 && <span className="sep">→</span>}
        </span>
      ))}
    </div>
  );
}

function ContextCard({
  context,
  hue,
  isActive,
  onSelect,
}: {
  context: EngineContext;
  hue: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`card ctx hue-${hue % 5} ${isActive ? 'on' : ''}`} onClick={onSelect}>
      <span className="ctx-bar" aria-hidden />
      <div className="ctx-top">
        <span className="ctx-label">
          {context.labelIsFallback ? `${t('today.fallbackLabel')} ${context.label}` : context.label}
        </span>
        <span className="ctx-dur">{formatDuration(context.activeMs)}</span>
      </div>
      <AppChain apps={context.appChain} />
      <div className="ctx-foot">
        {context.eventRefs.length} {t('header.events')} · {t('today.confidence')}{' '}
        {Math.round(context.confidence * 100)}%
      </div>
    </button>
  );
}

function Rows({
  label,
  lines,
  tz,
  onCite,
}: {
  label: string;
  lines: {
    label: string;
    detail?: string;
    evidenceRef: string;
    timestamp: number;
    tone?: string;
  }[];
  tz: number;
  onCite: (ref: string) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="rows">
      <div className="eyebrow">{label}</div>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.tone ?? ''}`}>
          <span className="mono">{l.label}</span>
          {l.detail && <span className="detail">{l.detail}</span>}
          <button className="cite" onClick={() => onCite(l.evidenceRef)}>
            {clock(l.timestamp, tz)}
          </button>
        </div>
      ))}
    </div>
  );
}

function Anchors({ context }: { context: EngineContext }) {
  const sorted = [...context.anchors].sort((a, b) => b.confidence - a.confidence).slice(0, 14);
  if (sorted.length === 0) return null;
  return (
    <div className="card anchors">
      <div className="eyebrow">{t('anchors.title')}</div>
      <div className="tags">
        {sorted.map((a, i) => (
          <span key={i} className={`tag ${strength(a.type)}`} title={`${a.type} · ${a.source}`}>
            <em>{a.type}</em>
            {a.value}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Events the engine attached to nothing.
 *
 * These were once a single-line count, which made a captured event look deleted: it was in the file,
 * it just was not on screen anywhere. Nothing captured may be invisible.
 */
function LoosePanel({
  refs,
  byRef,
  tz,
}: {
  refs: string[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
}) {
  const events = refs
    .map((r) => byRef.get(r))
    .filter((e): e is GoldenEvent => Boolean(e))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (events.length === 0) return null;

  return (
    <div className="card loose">
      <div className="eyebrow">
        {t('today.loose')} · {events.length}
      </div>
      <ul className="loose-list">
        {events.map((e) => {
          const src = SOURCES[e.source] ?? { glyph: '·', label: e.source };
          return (
            <li key={e.ref} className={`src-${e.source}`}>
              <span className="tl-dot">{src.glyph}</span>
              <span className="tl-at">{clock(e.timestamp, tz)}</span>
              <span className="tl-text">{headline(e)}</span>
            </li>
          );
        })}
      </ul>
      <p className="footnote">{t('today.looseHint')}</p>
    </div>
  );
}

/** The engine returns which rule fired and its values; the wording lives here (§147). */
function renderNextStep(step: NextStep): string {
  switch (step.rule) {
    case 'quote_note':
      return step.text; // The user's own words, verbatim and never translated.
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
