/**
 * Politique analytics (slice 8) — bornes, vocabulaire fermé, normalisation
 * et signaux de vie privée. Toute valeur ici est une **règle serveur** :
 * le beacon navigateur est un capteur muet, jamais une source d'autorité
 * (même principe que les formulaires, §2.7).
 *
 * Modèle de confidentialité :
 * - **aucune IP persistée** — elle n'est même pas dérivée en pseudonyme
 *   stocké : elle ne sert qu'à la clé de rate limiting (HMAC éphémère,
 *   même dérivation que le login) puis est jetée ;
 * - **aucun User-Agent brut stocké** — seulement une classe d'appareil
 *   grossière (mobile/tablet/desktop) dérivée à la volée ;
 * - **aucune query string stockée** — le chemin seul ; les seuls paramètres
 *   conservés sont les UTM explicitement whitelistés ;
 * - **referrer réduit au domaine** — jamais l'URL complète (elle peut
 *   contenir des données sensibles) ;
 * - **session éphémère par onglet** (sessionStorage) — pas de cookie,
 *   pas d'identifiant persistant, rien de cross-site ;
 * - signal de vie privée explicite (DNT / GPC) → **aucune collecte**.
 *
 * Bot filtering volontairement minimal (pas de base d'UA) : quelques
 * marqueurs évidents + préfetch/prerender détectables. En cas de doute,
 * un peu de bruit dans les stats vaut mieux qu'un filtre fragile.
 */

// ——— Vocabulaire fermé des événements ———

/**
 * Événements collectables depuis le **navigateur** (endpoint public).
 * Le client ne peut jamais émettre un nom hors de cette liste : la
 * cardinalité du vocabulaire est bornée par construction.
 */
export const CLIENT_EVENT_NAMES = ['page_view', 'cta_click'] as const;
/**
 * Événements **serveur** (conversions) — jamais acceptés depuis l'endpoint
 * public : ils sont émis par le service contact quand une soumission est
 * réellement acceptée / notifiée. Analytics ≠ audit : la traçabilité
 * opérationnelle reste dans `kreiz_admin_audit_log`.
 */
export const SERVER_EVENT_NAMES = ['form_accepted', 'form_notification_sent'] as const;

export const ANALYTICS_EVENT_NAMES = [...CLIENT_EVENT_NAMES, ...SERVER_EVENT_NAMES] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export type AnalyticsClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

// ——— Bornes de payload ———

/** Taille maximale du corps JSON accepté — borne anti-abus dure de la route. */
export const ANALYTICS_BODY_MAX_BYTES = 2 * 1024;
/** Longueur maximale d'un chemin (pathname) stocké. */
export const ANALYTICS_PATH_MAX_LENGTH = 512;
/** Longueur maximale du referrer brut accepté (avant réduction au domaine). */
export const ANALYTICS_REFERRER_INPUT_MAX_LENGTH = 2048;
/** Longueur maximale d'un domaine de referrer stocké. */
export const ANALYTICS_REFERRER_DOMAIN_MAX_LENGTH = 253;
/** Longueur maximale d'un identifiant de session (UUID canonique = 36). */
export const ANALYTICS_SESSION_MAX_LENGTH = 64;
/** Valeur UTM — borne stricte par champ. */
export const ANALYTICS_UTM_MAX_LENGTH = 128;
export const ANALYTICS_UTM_FIELDS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
export type AnalyticsUtmField = (typeof ANALYTICS_UTM_FIELDS)[number];
/** Tag de langue borné (forme BCP-47 simple : `fr`, `en-US`). */
export const ANALYTICS_LOCALE_MAX_LENGTH = 35;
/** Identifiant de CTA (`data-kz-cta`) borné. */
export const ANALYTICS_CTA_ID_MAX_LENGTH = 64;

// ——— Chemins exclus ———

/**
 * Préfixes exclus **par défaut** : back-office, endpoints et preview ne
 * comptent jamais dans les statistiques publiques (public analytics =
 * expérience publique publiée uniquement). Santé et assets ne passent de
 * toute façon pas par le beacon (pas de page HTML), mais l'exclusion par
 * extension protège d'un beacon posé trop large par un Project.
 */
export const ANALYTICS_DEFAULT_EXCLUDED_PREFIXES = ['/admin', '/api'] as const;
/** Extensions de fichiers statiques jamais comptées comme pages. */
export const ANALYTICS_ASSET_EXTENSIONS = [
  '.js',
  '.mjs',
  '.css',
  '.map',
  '.json',
  '.xml',
  '.txt',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
] as const;

/**
 * Chemin exclu de la collecte — préfixe par défaut (`/admin`, `/api`),
 * préfixe supplémentaire configuré par le Project, ou extension d'asset.
 * Préfixe strict (pas d'effet de bord `/apidoc`) et **insensible à la
 * casse** : `/Admin/…` ne doit jamais devenir une « page populaire ».
 */
export function isExcludedAnalyticsPath(path: string, extraPrefixes: readonly string[] = []): boolean {
  const lowered = path.toLowerCase();
  const candidates = [lowered, `${lowered}/`];
  for (const prefix of [...ANALYTICS_DEFAULT_EXCLUDED_PREFIXES, ...extraPrefixes]) {
    const loweredPrefix = prefix.toLowerCase();
    for (const candidate of candidates) {
      if (candidate === loweredPrefix || candidate.startsWith(`${loweredPrefix}/`)) return true;
    }
  }
  return ANALYTICS_ASSET_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

// ——— Normalisation ———

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Chemin (pathname) stockable : commence par « / », sans query ni fragment
 * (jamais stockés), sans caractère de contrôle (CR/LF inclus), borné. Une
 * URL absolue, un chemin vide ou invalide → `null` (jamais une troncature
 * silencieuse d'un chemin découpé arbitrairement).
 */
export function normalizeAnalyticsPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ANALYTICS_PATH_MAX_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (CONTROL_CHARS.test(value)) return null;
  const queryIndex = value.search(/[?#]/);
  const path = queryIndex === -1 ? value : value.slice(0, queryIndex);
  if (path.length === 0 || path.length > ANALYTICS_PATH_MAX_LENGTH) return null;
  if (CONTROL_CHARS.test(path)) return null;
  return path;
}

/**
 * Referrer réduit au **domaine** (host, minuscule) — l'URL complète n'est
 * jamais stockée (tokens, emails, termes de recherche privés). Entrée non
 * URL, scheme exotique (app://, data:) ou vide → `null` (= accès direct).
 */
export function normalizeReferrerDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().slice(0, ANALYTICS_REFERRER_INPUT_MAX_LENGTH);
  if (value.length === 0) return null;
  let host: string | null = null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = url.host.toLowerCase();
  } catch {
    return null;
  }
  if (!host || host.length > ANALYTICS_REFERRER_DOMAIN_MAX_LENGTH) return null;
  return host;
}

/**
 * Classification du referrer : `null` = accès direct (domaine absent),
 * `internal` = même hôte que la requête ou domaine déclaré interne par le
 * Project, `external` = tout le reste.
 */
export function classifyReferrer(
  domain: string | null,
  context: { requestHost: string | null; internalDomains?: readonly string[] },
): 'internal' | 'external' | null {
  if (!domain) return null;
  const requestHost = context.requestHost?.toLowerCase() ?? null;
  if (requestHost && domain === requestHost) return 'internal';
  const normalized = context.internalDomains?.map((entry) => entry.trim().toLowerCase()) ?? [];
  if (normalized.includes(domain)) return 'internal';
  return 'external';
}

/**
 * Valeur UTM normalisée : trim, caractères de contrôle interdits,
 * minuscules (une campagne `Newsletter` et `newsletter` ne doivent pas
 * doubler la cardinalité), espaces internes collapses, borne stricte.
 * Vide après normalisation → `null` (colonne nullable, jamais chaîne vide).
 */
export function normalizeUtmValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) return null;
  if (CONTROL_CHARS.test(collapsed)) return null;
  const value = collapsed.toLowerCase().slice(0, ANALYTICS_UTM_MAX_LENGTH);
  return value.length > 0 ? value : null;
}

/** Les cinq champs UTM d'un enregistrement, normalisés (null = absent). */
export type AnalyticsUtm = Readonly<Record<AnalyticsUtmField, string | null>>;

export function emptyUtm(): AnalyticsUtm {
  return { source: null, medium: null, campaign: null, content: null, term: null };
}

/** Tag de langue borné et normalisé (minuscules) — sinon `null`. */
export function normalizeAnalyticsLocale(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ANALYTICS_LOCALE_MAX_LENGTH) return null;
  if (!/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(value)) return null;
  return value.toLowerCase();
}

const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Session analytics — UUID v4 généré par le beacon, stocké dans
 * sessionStorage (éphémère, par onglet, jamais cross-site). Format
 * **strictement** validé : toute autre valeur → `null` (l'événement reste
 * compté comme page vue, sans session) — un client hostile ne peut pas
 * injecter de charge arbitraire dans la colonne.
 */
export function normalizeAnalyticsSession(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length > ANALYTICS_SESSION_MAX_LENGTH) return null;
  return SESSION_PATTERN.test(value) ? value : null;
}

/** Identifiant de CTA (`data-kz-cta`) borné et sans caractère de contrôle. */
export function normalizeCtaId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().slice(0, ANALYTICS_CTA_ID_MAX_LENGTH);
  if (value.length === 0 || CONTROL_CHARS.test(value)) return null;
  return value;
}

// ——— Signaux serveur : bots, prefetch, vie privée ———

/**
 * Marqueurs de bots **volontairement minimaux** (crawlers évidents, outils
 * de test, monitoring) — pas une base d'UA géante : accepter un peu de
 * bruit est assumé (politique documentée). Match par sous-chaîne, être
 * large ici n'exclut qu'un faux navigateur légitime rare.
 */
export const ANALYTICS_BOT_USER_AGENT_MARKERS = [
  'bot',
  'crawler',
  'spider',
  'crawl',
  'slurp',
  'curl/',
  'wget',
  'python-requests',
  'python-urllib',
  'headlesschrome',
  'phantomjs',
  'lighthouse',
  'phantom',
  'monitoring',
  'uptime',
  'preview',
] as const;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const value = (userAgent ?? '').toLowerCase();
  if (value.length === 0) return false; // UA absent : rare bruit toléré
  return ANALYTICS_BOT_USER_AGENT_MARKERS.some((marker) => value.includes(marker));
}

/** Classe d'appareil grossière dérivée à la volée — l'UA brut n'est jamais stocké. */
export function deviceClassFromUserAgent(
  userAgent: string | null | undefined,
): 'mobile' | 'tablet' | 'desktop' | null {
  const value = (userAgent ?? '').toLowerCase();
  if (value.length === 0) return null;
  if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
  if (value.includes('mobi') || value.includes('iphone') || value.includes('android')) return 'mobile';
  return 'desktop';
}

/** Préfetch/prerender détectables (Chrome `Sec-Purpose`, historique `X-Moz`). */
export function isPrefetchRequest(headers: {
  get(name: string): string | null;
}): boolean {
  const secPurpose = headers.get('sec-purpose');
  if (secPurpose && /prefetch|prerender/i.test(secPurpose)) return true;
  const purpose = headers.get('purpose');
  if (purpose && /prefetch|prerender/i.test(purpose)) return true;
  const moz = headers.get('x-moz');
  return moz !== null && /prefetch/i.test(moz);
}

/**
 * Signal de vie privée explicite — `DNT: 1` ou `Sec-GPC: 1`. Politique
 **conservative assumée** : signal présent ⇒ aucune collecte (voir docs
 * slice 8 ; pas de distinction fine par navigateur, pas de consentement
 * à moitié).
 */
export function hasExplicitPrivacySignal(headers: {
  get(name: string): string | null;
}): boolean {
  return headers.get('dnt') === '1' || headers.get('sec-gpc') === '1';
}

// ——— Rate limiting (réutilise le mécanisme PostgreSQL des slices 2/7) ———

/** Fenêtre de rate limiting du collecteur public. */
export const ANALYTICS_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Événements acceptés par fenêtre et par IP pseudonymisée (bursts navigations inclus). */
export const ANALYTICS_RATE_LIMIT_MAX = 30;
/** Clé de rate limiting du collecteur — même dérivation HMAC que le login. */
export function analyticsRateLimitKey(ipHash: string): string {
  return `analytics:${ipHash}`;
}

// ——— Déduplication légère des page views ———

/**
 * Fenêtre de déduplication : rechargement très rapide, double beacon,
 * retry réseau. Tranche **alignée sur l'horloge** (pas glissante) : deux
 * envois identiques (même session, même événement, même chemin) dans la
 * même tranche de 30 s ne produisent qu'une ligne ; au-delà, un vrai
 * rechargement est légitimement recompté. Précision parfaite explicitement
 * non visée (politique documentée).
 */
export const ANALYTICS_DEDUP_WINDOW_MS = 30 * 1000;

/** Clé de déduplication serveur — clients identifiés par leur session UUID éphémère. */
export function analyticsDedupKey(options: {
  sessionId: string | null;
  eventName: AnalyticsEventName;
  path: string;
  ctaId?: string | null;
  now: Date;
}): string | null {
  if (!options.sessionId) return null;
  const bucket = Math.floor(options.now.getTime() / ANALYTICS_DEDUP_WINDOW_MS);
  return [options.sessionId, options.eventName, options.path, options.ctaId ?? '', bucket].join('|');
}

// ——— Rétention ———

export const ANALYTICS_RETENTION_MIN_DAYS = 7;
export const ANALYTICS_RETENTION_MAX_DAYS = 365;
export const ANALYTICS_RETENTION_DEFAULT_DAYS = 90;

// ——— Résolution contenu (performance de contenu) ———

/** Chemin découpé en route namespace + slug (`/articles/foo` → articles, foo). */
export function splitContentPath(path: string): { namespace: string; slug: string } | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const [namespace, ...rest] = segments;
  return { namespace: namespace!, slug: rest.join('/') };
}

// ——— Agrégations ———

/** Périodes de dashboard autorisées — rien d'autre n'est requêtable. */
export const ANALYTICS_DASHBOARD_PERIODS = [7, 30, 90] as const;
export type AnalyticsDashboardPeriod = (typeof ANALYTICS_DASHBOARD_PERIODS)[number];

export function isDashboardPeriod(value: unknown): value is AnalyticsDashboardPeriod {
  return typeof value === 'number' && (ANALYTICS_DASHBOARD_PERIODS as readonly number[]).includes(value);
}

/**
 * Clé de jour pour l'agrégation journalière — **UTC partout au niveau Core**
 * (stockage timestamptz, buckets `date_trunc('day')` UTC ; un affichage
 * localisé côté admin est une variante d'affichage documentée, jamais un
 * mélange de timezones à la collecte).
 */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
