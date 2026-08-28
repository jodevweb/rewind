/**
 * Internationalisation (§147).
 *
 * The specification asked for an i18n layer from day one, and it was right to: the alternative is
 * hardcoded strings that have to be hunted down later. What it got wrong — and what I copied without
 * asking — was English as the default. The person using this works in French.
 *
 * So: French is the default, English is available, and no user-facing string is written inline in a
 * component. The lint rule in ROADMAP P12-005 that bans string literals in JSX has something real to
 * enforce now.
 */

export type Locale = 'fr' | 'en';

export const DEFAULT_LOCALE: Locale = 'fr';

const fr = {
  'app.subtitle': 'Studio',
  'app.recording': 'Enregistrement',
  'app.paused': 'En pause',
  'app.pausedUntil': 'En pause jusqu’à',
  'app.resume': 'Reprendre',
  'app.empty':
    'REWIND apprend ton travail. Utilise ta machine normalement — les premiers contextes apparaissent après quelques minutes.',
  'perm.title': 'Accessibility n’est pas accordée.',
  'perm.body':
    'REWIND voit quelle application est active mais pas le titre de ses fenêtres — et le titre est l’essentiel du signal. macOS laisse toujours une application lire son propre titre, jamais celui des autres : c’est pour ça que tu ne vois que REWIND. Ouvre Réglages Système → Confidentialité et sécurité → Accessibilité, ajoute REWIND et relance-le. REWIND ne prend aucune capture d’écran et ne demande jamais l’enregistrement d’écran.',

  'badge.fixture': 'FICTIF — données de test écrites à la main',
  'badge.real': 'RÉEL — capturé sur cette machine',

  'banner.title': 'Tout ce qui suit est fictif.',
  'banner.body':
    'Ces dix sessions sont des données de test écrites à la main, qui servent à noter le moteur. Pour voir ta propre activité, lance',
  'banner.body2':
    'dans un second terminal et utilise ta machine normalement — une session réelle apparaît en tête de la liste en moins d’une minute, marquée ●, et se rafraîchit pendant que tu travailles.',

  'header.events': 'événements',
  'header.contexts_one': 'contexte',
  'header.contexts_other': 'contextes',
  'header.deterministic': 'déterministe, sans LLM',
  'header.kept': 'conservés',
  'diag.titles': 'titres de fenêtres :',
  'diag.granted': 'accessibles',
  'diag.denied': 'refusés',
  'diag.not_required': 'aucune permission requise',

  'today.title': "Aujourd'hui",
  'today.hint':
    'Des contextes, pas des applications. Les durées excluent le temps d’inactivité et n’apparaissent jamais par application.',
  'today.unassigned_one': 'événement laissé de côté',
  'today.unassigned_other': 'événements laissés de côté',
  'today.unassigned_why': '— interruptions et bruit que le moteur a refusé de rattacher.',
  'today.confidence': 'confiance',
  'today.none':
    'Aucun contexte pour l’instant. Il faut au moins deux événements partageant une ancre — continue à travailler.',
  'today.loose': 'Hors contexte',
  'today.looseHint':
    'Ces événements ont bien été capturés. Le moteur n’a simplement pas trouvé assez de liens pour en faire un contexte — il faut au moins deux événements qui partagent une ancre.',
  'today.fallbackLabel': 'Travail dans',

  'next.fixFailing': 'Corriger la commande qui échoue :',
  'next.commitOrStash': 'Commiter ou remiser',
  'next.files_one': 'fichier non commité',
  'next.files_other': 'fichiers non commités',
  'next.onBranch': 'sur',
  'next.reviewAgent': 'Relire le travail de l’agent',

  'resume.title': 'Reprendre',
  'resume.wasWorkingOn': 'Tu travaillais sur',
  'resume.lastActivity': 'Dernière activité',
  'resume.active': 'actif',
  'resume.files': 'Fichiers',
  'resume.reading': 'Lectures',
  'resume.ran': 'Commandes',
  'resume.failed': 'Échecs',
  'resume.produced': 'Produit',
  'resume.nextStep': 'Prochaine étape suggérée',
  'resume.evidence': 'preuve',
  'resume.open': 'Ouvrir',
  'resume.footnote':
    'Chaque ligne ci-dessus est lue dans les événements stockés. Rien ici n’est généré.',
  'resume.none': 'Aucun contexte détecté dans cette session.',

  'anchors.title':
    'Ancres — pourquoi ces événements ont été regroupés. L’application n’est jamais la raison.',

  'truth.fixture': 'Vérité terrain (fixture)',
  'truth.real': 'Capture réelle — pas de vérité terrain',
  'truth.realBody':
    'Personne n’a annoté cette session, il n’y a donc rien contre quoi la noter. Juge-la comme tu jugerais ton propre souvenir de la journée : est-ce que ce sont bien les travaux que tu as faits ?',
  'truth.found': 'le moteur a trouvé',
  'truth.expected': 'attendu',

  'timeline.title': 'Chronologie',

  'openKind.url': 'la page',
  'openKind.workspace': "l'espace de travail",
  'openKind.terminal': 'un terminal',
} as const;

type Key = keyof typeof fr;

const en: Record<Key, string> = {
  'app.subtitle': 'Studio',
  'app.recording': 'Recording',
  'app.paused': 'Paused',
  'app.pausedUntil': 'Paused until',
  'app.resume': 'Resume',
  'app.empty':
    'REWIND is learning your work. Use your machine normally — the first contexts appear after a few minutes.',
  'perm.title': 'Accessibility is not granted.',
  'perm.body':
    'REWIND sees which application is active but not its window titles — and the titles are most of the signal. macOS always lets an application read its own title and never another’s, which is why you only see REWIND. Open System Settings → Privacy & Security → Accessibility, add REWIND, and restart it. REWIND takes no screenshots and never requests Screen Recording.',

  'badge.fixture': 'FIXTURE — authored test data',
  'badge.real': 'REAL — captured on this machine',

  'banner.title': 'Everything below is fake.',
  'banner.body':
    'These ten sessions are hand-authored test data used to score the engine. To see your own activity, run',
  'banner.body2':
    'in a second terminal and use your machine normally — a real session appears at the top of the picker within a minute, marked ●, and refreshes while you work.',

  'header.events': 'events',
  'header.contexts_one': 'context',
  'header.contexts_other': 'contexts',
  'header.deterministic': 'deterministic, no LLM',
  'header.kept': 'kept',
  'diag.titles': 'window titles:',
  'diag.granted': 'readable',
  'diag.denied': 'denied',
  'diag.not_required': 'no permission needed',

  'today.title': 'Today',
  'today.hint':
    'Contexts, not applications. Durations exclude idle time and never appear per application.',
  'today.unassigned_one': 'event left unassigned',
  'today.unassigned_other': 'events left unassigned',
  'today.unassigned_why': '— interruptions and noise the engine declined to attach.',
  'today.confidence': 'confidence',
  'today.none': 'No context yet. Two events sharing an anchor are needed — keep working.',
  'today.loose': 'Outside any context',
  'today.looseHint':
    'These events were captured. The engine simply did not find enough links to form a context — it needs at least two events sharing an anchor.',
  'today.fallbackLabel': 'Work in',

  'next.fixFailing': 'Fix the failing command:',
  'next.commitOrStash': 'Commit or stash',
  'next.files_one': 'uncommitted file',
  'next.files_other': 'uncommitted files',
  'next.onBranch': 'on',
  'next.reviewAgent': "Review the agent's work",

  'resume.title': 'Resume',
  'resume.wasWorkingOn': 'You were working on',
  'resume.lastActivity': 'Last activity',
  'resume.active': 'active',
  'resume.files': 'Files',
  'resume.reading': 'Reading',
  'resume.ran': 'Ran',
  'resume.failed': 'Failed',
  'resume.produced': 'Produced',
  'resume.nextStep': 'Suggested next step',
  'resume.evidence': 'evidence',
  'resume.open': 'Open',
  'resume.footnote': 'Every line above is read from stored events. Nothing here is generated.',
  'resume.none': 'No context detected in this session.',

  'anchors.title': 'Anchors — why these events were grouped. The application is never the reason.',

  'truth.fixture': 'Ground truth (fixture)',
  'truth.real': 'Real capture — no ground truth',
  'truth.realBody':
    'Nobody labelled this session, so there is nothing to score against. Judge it the way you would judge your own memory of the day: are these the pieces of work you actually did?',
  'truth.found': 'engine found',
  'truth.expected': 'expected',

  'timeline.title': 'Timeline',

  'openKind.url': 'the page',
  'openKind.workspace': 'the workspace',
  'openKind.terminal': 'a terminal',
};

const DICTS: Record<Locale, Record<Key, string>> = { fr, en };

let locale: Locale = DEFAULT_LOCALE;

export function setLocale(next: Locale): void {
  locale = next;
}

export function getLocale(): Locale {
  return locale;
}

export function t(key: Key): string {
  return DICTS[locale][key];
}

/** ICU-style plural selection, kept to the one rule these strings actually need. */
export function tPlural(
  base: 'header.contexts' | 'today.unassigned' | 'next.files',
  n: number,
): string {
  return t(`${base}_${n === 1 ? 'one' : 'other'}` as Key);
}

/** Durations read as "1h28" / "42m" in both locales; only the separator differs. */
export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}
