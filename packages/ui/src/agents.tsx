/**
 * "Tes agents": connect REWIND to the coding agents on this machine.
 *
 * One sheet, one list. Each installed agent says whether it can read your history, with the one
 * button that changes that. The daemon does the editing; this only shows what is true afterwards.
 */

import { useEffect, useRef, useState } from 'react';

import { t } from './i18n.js';

export interface AgentStatus {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  stale: boolean;
  problem: string | null;
}

export interface AgentsReport {
  nodeFound: boolean;
  nodeVersion: string | null;
  nodeTooOld: boolean;
  agents: AgentStatus[];
}

export interface AgentsApi {
  report: () => Promise<AgentsReport>;
  set: (id: string, connect: boolean) => Promise<AgentsReport>;
}

function stateOf(a: AgentStatus): { label: string; tone: 'ok' | 'off' | 'warn' } {
  if (a.problem) return { label: t('agents.problem'), tone: 'warn' };
  if (a.connected && a.stale) return { label: t('agents.stale'), tone: 'warn' };
  if (a.connected) return { label: t('agents.connected'), tone: 'ok' };
  return { label: t('agents.notConnected'), tone: 'off' };
}

export function AgentsSheet({ api, onClose }: { api: AgentsApi; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<AgentsReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    api
      .report()
      .then(setReport)
      .catch((e) => setError(String(e)));
  }, [api]);

  const change = async (a: AgentStatus, connect: boolean) => {
    setBusy(a.id);
    setError(null);
    try {
      setReport(await api.set(a.id, connect));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const installed = report?.agents.filter((a) => a.installed || a.connected) ?? [];
  const absent = report?.agents.filter((a) => !a.installed && !a.connected) ?? [];

  return (
    <dialog ref={dialog} className="agents" onClose={onClose} aria-labelledby="agents-title">
      <header className="agents-head">
        <h2 id="agents-title">{t('agents.title')}</h2>
        <button className="home-link" onClick={() => dialog.current?.close()}>
          {t('agents.close')}
        </button>
      </header>
      <p className="agents-intro">{t('agents.intro')}</p>

      {report && !report.nodeFound && (
        <p className="agents-notice">
          {report.nodeTooOld
            ? t('agents.nodeOld').replace('{v}', report.nodeVersion ?? '')
            : t('agents.nodeMissing')}
        </p>
      )}

      {!report && !error && <p className="agents-muted">{t('agents.loading')}</p>}

      {installed.length > 0 && (
        <ul className="agents-list">
          {installed.map((a) => {
            const s = stateOf(a);
            const fix = a.stale;
            return (
              <li key={a.id} className="agents-row">
                <div className="agents-who">
                  <span className="agents-name">{a.name}</span>
                  <span className={`agents-state ${s.tone}`}>
                    <span className="agents-dot" aria-hidden />
                    {s.label}
                  </span>
                  {a.problem && <span className="agents-problem">{a.problem}</span>}
                </div>
                <div className="agents-buttons">
                  {fix && (
                    <button
                      className="home-primary agents-btn"
                      disabled={busy !== null || !report?.nodeFound}
                      onClick={() => void change(a, true)}
                    >
                      {t('agents.repair')}
                    </button>
                  )}
                  {a.connected ? (
                    <button
                      className="home-secondary agents-btn"
                      disabled={busy !== null || Boolean(a.problem && !a.stale)}
                      onClick={() => void change(a, false)}
                    >
                      {busy === a.id ? '…' : t('agents.disconnect')}
                    </button>
                  ) : (
                    <button
                      className="home-primary agents-btn"
                      disabled={busy !== null || !report?.nodeFound || Boolean(a.problem)}
                      onClick={() => void change(a, true)}
                    >
                      {busy === a.id ? '…' : t('agents.connect')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {report && installed.length === 0 && <p className="agents-muted">{t('agents.none')}</p>}

      {error && <p className="agents-error">{error}</p>}

      {absent.length > 0 && (
        <p className="agents-muted">
          {t('agents.absent').replace('{list}', absent.map((a) => a.name).join(', '))}
        </p>
      )}
      <p className="agents-muted">{t('agents.others')}</p>
    </dialog>
  );
}
