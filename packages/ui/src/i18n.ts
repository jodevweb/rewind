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
  'update.available': 'Nouvelle version disponible —',
  'update.install': 'Installer et relancer',
  'update.installing': 'Installation…',
  'update.check': 'Vérifier les mises à jour',
  'update.checking': 'Vérification…',
  'update.upToDate': 'À jour',
  'update.failed': 'Échec de la vérification :',
  'update.never': 'jamais vérifié',
  'update.lastCheck': 'dernière vérification',
  'app.version': 'version',
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
  'today.fallbackLabel': 'Activité dans',

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
  'today.earlier': 'Plus tôt dans la journée',
  'detail.title': 'Détail',
  'detail.when': 'Heure',
  'detail.duration': 'Durée',
  'detail.app': 'Application',
  'detail.source': 'Source',
  'detail.kind': 'Type',
  'detail.tools': 'Outils utilisés',
  'detail.open': 'Ouvrir',
  'detail.reveal': 'Afficher dans le dossier',
  'detail.redacted': 'Secrets masqués avant enregistrement :',
  'timeline.newestFirst': 'du plus récent au plus ancien',
  'predict.drift': 'Tu as changé de sujet',
  'predict.driftBody': 'Tu travaillais sur',
  'predict.driftFor': 'il y a',
  'predict.driftNowOn': '— depuis, tu es sur',
  'predict.driftThreshold': 'Signalé au-delà de ton temps de retour habituel :',
  'predict.usuallyReturns': 'tu y reviens généralement',
  'predict.next': 'Ce que tu reprends d’habitude',
  'predict.lastSeen': 'dernière fois à',
  'predict.from': 'À partir de',
  'predict.days': 'jour(s) d’historique',
  'predict.rhythm': 'Ta journée, mesurée',
  'predict.active': 'Temps actif',
  'predict.contexts': 'Contextes',
  'predict.contextsShort': 'contextes',
  'predict.switches': 'changements',
  'predict.median': 'Contexte médian',
  'predict.deep': 'Travail continu',
  'predict.busiest': 'Heure la plus morcelée',
  'predict.typical': 'Journée typique',
  'predict.interruption': 'Ce que coûte une interruption',
  'predict.interruptionBody': 'Quand tu quittes un sujet, tu y reviens en général après',
  'predict.returnRate': 'Tu reviens dans',
  'predict.returnRateBody': 'des cas',
  'predict.observations': 'observations',

  'openKind.url': 'la page',
  'openKind.workspace': "l'espace de travail",
  'openKind.terminal': 'un terminal',

  'ask.placeholder': 'Pose une question — « où était cette doc ? », « hier après-midi »…',
  'ask.intent.resume': 'Reprendre',
  'ask.intent.temporal': 'Période',
  'ask.intent.retrieval': 'Retrouver',
  'ask.intent.causal': 'Pourquoi',
  'ask.intent.summary': 'Résumé',
  'ask.intent.navigation': 'Aller à',
  'ask.intent.comparison': 'Comparer',
  'ask.ambiguous': 'Deux lectures possibles — la plus proche est retenue',
  'ask.closest': 'Ce qui s’en rapproche le plus',
  'ask.refusal.no_match': 'Rien de ce qui est enregistré ne correspond à cette question.',
  'ask.refusal.below_threshold':
    'Pas assez de preuves pour répondre. Voici ce qui s’en rapproche, sans que ce soit une réponse.',
  'ask.refusal.insufficient_evidence':
    'Une seule trace le mentionne. Une cause demande au moins deux sources — REWIND n’en invente pas.',
  'ask.refusal.empty_window': 'Rien n’a été capturé sur cette période.',
  'ask.refusal.hint':
    'Essaie une autre période, ou un fichier, une commande ou une page dont tu te souviens.',
  'ask.open': 'Ouvrir',
  'ask.nothing': 'Aucun résultat.',
  'ask.foot': '↑↓ naviguer · ⏎ aller au moment · ⌘⏎ ouvrir · échap fermer',
  'ask.examples': 'Par exemple',
  'ask.example1': 'sur quoi je travaillais ?',
  'ask.example2': 'où était la doc stripe ?',
  'ask.example3': 'qu’est-ce que j’ai fait hier après-midi ?',
  'ask.example4': 'quelle commande a échoué ?',
} as const;

export type Key = keyof typeof fr;

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
  'update.available': 'New version available —',
  'update.install': 'Install and restart',
  'update.installing': 'Installing…',
  'update.check': 'Check for updates',
  'update.checking': 'Checking…',
  'update.upToDate': 'Up to date',
  'update.failed': 'Check failed:',
  'update.never': 'never checked',
  'update.lastCheck': 'last checked',
  'app.version': 'version',
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
  'today.fallbackLabel': 'Activity in',

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
  'today.earlier': 'Earlier today',
  'detail.title': 'Detail',
  'detail.when': 'Time',
  'detail.duration': 'Duration',
  'detail.app': 'Application',
  'detail.source': 'Source',
  'detail.kind': 'Kind',
  'detail.tools': 'Tools used',
  'detail.open': 'Open',
  'detail.reveal': 'Reveal in folder',
  'detail.redacted': 'Secrets masked before storage:',
  'timeline.newestFirst': 'newest first',
  'predict.drift': 'You have moved on',
  'predict.driftBody': 'You were working on',
  'predict.driftFor': 'until',
  'predict.driftNowOn': '— since then you have been on',
  'predict.driftThreshold': 'Reported past your usual time away:',
  'predict.usuallyReturns': 'you normally come back to it',
  'predict.next': 'What you usually pick up',
  'predict.lastSeen': 'last at',
  'predict.from': 'From',
  'predict.days': 'day(s) of history',
  'predict.rhythm': 'Your day, measured',
  'predict.active': 'Active time',
  'predict.contexts': 'Contexts',
  'predict.contextsShort': 'contexts',
  'predict.switches': 'switches',
  'predict.median': 'Median context',
  'predict.deep': 'Uninterrupted work',
  'predict.busiest': 'Most fragmented hour',
  'predict.typical': 'Typical day',
  'predict.interruption': 'What an interruption costs',
  'predict.interruptionBody': 'When you leave a subject, you usually return after',
  'predict.returnRate': 'You come back',
  'predict.returnRateBody': 'of the time',
  'predict.observations': 'observations',

  'openKind.url': 'the page',
  'openKind.workspace': 'the workspace',
  'openKind.terminal': 'a terminal',

  'ask.placeholder': 'Ask a question — “where was that doc?”, “yesterday afternoon”…',
  'ask.intent.resume': 'Resume',
  'ask.intent.temporal': 'Time range',
  'ask.intent.retrieval': 'Find',
  'ask.intent.causal': 'Why',
  'ask.intent.summary': 'Summary',
  'ask.intent.navigation': 'Go to',
  'ask.intent.comparison': 'Compare',
  'ask.ambiguous': 'Two honest readings — the nearer one was taken',
  'ask.closest': 'The closest it came',
  'ask.refusal.no_match': 'Nothing that was recorded matches that question.',
  'ask.refusal.below_threshold':
    'Not enough evidence to answer that. Here is the closest it came, which is not an answer.',
  'ask.refusal.insufficient_evidence':
    'Only one trace mentions it. A cause needs at least two sources — REWIND does not invent one.',
  'ask.refusal.empty_window': 'Nothing was captured in that window.',
  'ask.refusal.hint': 'Try a different time range, or a file, a command or a page you remember.',
  'ask.open': 'Open',
  'ask.nothing': 'No results.',
  'ask.foot': '↑↓ move · ⏎ go to that moment · ⌘⏎ open · esc to close',
  'ask.examples': 'For example',
  'ask.example1': 'what was I working on?',
  'ask.example2': 'where was the stripe doc?',
  'ask.example3': 'what did I do yesterday afternoon?',
  'ask.example4': 'what command failed?',
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
