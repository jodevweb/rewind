/**
 * What the prediction layer has to say, and what it refuses to say.
 *
 * Every panel here shows its evidence, and every one disappears entirely rather than showing a
 * hedge. A panel reading "not enough data yet" on a screen someone looks at daily becomes furniture
 * within a week; an absent panel is read correctly as "nothing to report".
 *
 * There are no targets and no colours-as-judgement. A fragmented day is reported as a fragmented
 * day, which is a fact. Whether that was the right way to spend it is not something a window-title
 * log can know, and a tool that pretends otherwise becomes one people perform for.
 */

import type { Predictions } from '@rewind/predict';

import { formatDuration, t } from './i18n.js';

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

export function Forecast({
  predictions,
  tz,
  onSelect,
}: {
  predictions: Predictions;
  tz: number;
  onSelect?: (label: string) => void;
}) {
  const { rhythm, interruption, suggestions, drift, daysOfHistory } = predictions;
  const today = rhythm.days[rhythm.days.length - 1];

  return (
    <>
      {drift && (
        <div className="card drift">
          <div className="eyebrow">{t('predict.drift')}</div>
          <p>
            {t('predict.driftBody')} <b>{drift.fromLabel}</b> {t('predict.driftFor')}{' '}
            <b>{formatDuration(drift.awayMs)}</b>
            {drift.toLabel ? (
              <>
                {' '}
                {t('predict.driftNowOn')} <b>{drift.toLabel}</b>
              </>
            ) : null}
            .
          </p>
          {/* The threshold is shown so the judgement can be judged. It is the reader's own median
              excursion, not a number someone chose. */}
          <p className="footnote">
            {t('predict.driftThreshold')} {formatDuration(drift.thresholdMs)}
            {drift.usuallyReturns === true ? ` · ${t('predict.usuallyReturns')}` : ''}
          </p>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="card">
          <div className="eyebrow">{t('predict.next')}</div>
          {suggestions.map((s) => (
            <button
              key={s.key}
              className="suggestion"
              onClick={() => onSelect?.(s.label)}
              disabled={!onSelect}
            >
              <span className="suggestion-label">{s.label}</span>
              <span className="suggestion-why">{s.evidence.join(' · ')}</span>
              {s.lastActiveAt > 0 && (
                <span className="suggestion-when">
                  {t('predict.lastSeen')} {clock(s.lastActiveAt, tz)} ·{' '}
                  {formatDuration(s.lastActiveMs)}
                </span>
              )}
            </button>
          ))}
          <p className="footnote">
            {t('predict.from')} {daysOfHistory} {t('predict.days')}
          </p>
        </div>
      )}

      {today && (
        <div className="card">
          <div className="eyebrow">{t('predict.rhythm')}</div>
          <dl className="kv">
            <div>
              <dt>{t('predict.active')}</dt>
              <dd>{formatDuration(today.activeMs)}</dd>
            </div>
            <div>
              <dt>{t('predict.contexts')}</dt>
              <dd>
                {today.contextCount} · {today.switches} {t('predict.switches')}
              </dd>
            </div>
            <div>
              <dt>{t('predict.median')}</dt>
              <dd>{formatDuration(today.medianContextMs)}</dd>
            </div>
            <div>
              <dt>{t('predict.deep')}</dt>
              <dd>
                {formatDuration(today.deepWorkMs)}
                {today.deepWorkCount > 0 ? ` · ${today.deepWorkCount}` : ''}
              </dd>
            </div>
            {today.busiestSwitchHour !== null && (
              <div>
                <dt>{t('predict.busiest')}</dt>
                <dd>{today.busiestSwitchHour} h</dd>
              </div>
            )}
            {daysOfHistory > 1 && (
              <div>
                <dt>{t('predict.typical')}</dt>
                <dd>
                  {formatDuration(rhythm.typical.activeMs)} · {rhythm.typical.contextCount}{' '}
                  {t('predict.contextsShort')}
                </dd>
              </div>
            )}
          </dl>
          <HourBars hours={rhythm.activeMsByHour} />
        </div>
      )}

      {interruption.medianReturnMs !== null && (
        <div className="card">
          <div className="eyebrow">{t('predict.interruption')}</div>
          <p>
            {t('predict.interruptionBody')} <b>{formatDuration(interruption.medianReturnMs)}</b>.
          </p>
          {interruption.returnRate !== null && (
            <p className="footnote">
              {t('predict.returnRate')} {Math.round(interruption.returnRate * 100)} %{' '}
              {t('predict.returnRateBody')} · {interruption.observations.length}{' '}
              {t('predict.observations')}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Active time per hour. A shape, not a chart — it answers "when do I actually work". */
function HourBars({ hours }: { hours: number[] }) {
  const peak = Math.max(...hours, 1);
  const first = hours.findIndex((v) => v > 0);
  const last = hours.length - 1 - [...hours].reverse().findIndex((v) => v > 0);
  if (first === -1) return null;

  return (
    <div className="hours">
      {hours.slice(first, last + 1).map((v, i) => (
        <span
          key={first + i}
          className="hour"
          style={{ height: `${Math.max(2, Math.round((v / peak) * 34))}px` }}
          title={`${first + i} h — ${formatDuration(v)}`}
        />
      ))}
      <span className="hours-scale">
        {first} h — {last} h
      </span>
    </div>
  );
}
