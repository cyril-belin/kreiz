/**
 * Politique des formulaires publics (cadrage §13) — bornes, défauts et
 * validators purs. Toute valeur ici est une **règle serveur** : le
 * navigateur n'est jamais source d'autorité (principe §2.7).
 *
 * Anti-spam en profondeur, sans dépendance externe obligatoire :
 * 1. jeton d'émission signé (possession d'une vraie page du site, anti-replay borné) ;
 * 2. honeypot (champ leurre jamais affiché) ;
 * 3. temps minimum de remplissage (mesuré depuis l'émission du jeton) ;
 * 4. rate limiting PostgreSQL par hash d'IP (réutilise le mécanisme du login) ;
 * 5. validation stricte du payload (schéma dérivé, whitelist, bornes) ;
 * 6. validation d'`Origin`/`Sec-Fetch-Site` sur les POST publics (http/mutations).
 *
 * Vie privée : pas d'IP complète persistée (hash HMAC à finalité anti-abus
 * uniquement, même dérivation que le login), pas d'User-Agent brut stocké.
 */

// ——— Déclaration ———

/**
 * Clé de formulaire (`form_id`) — même grammaire que les clés de types de
 * contenu : identité en base (`form_id`), segment d'URL public
 * (`/api/forms/<key>`), id DOM sûr.
 */
export const CONTACT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
export const CONTACT_KEY_MAX_LENGTH = 80;
export const CONTACT_LABEL_MAX_LENGTH = 120;
export const CONTACT_DESCRIPTION_MAX_LENGTH = 300;

/** Nombre maximal de champs par formulaire — un contact n'est pas un questionnaire. */
export const CONTACT_FIELD_MAX_COUNT = 16;
/** Nom de champ déclarable — même grammaire que les clés (id DOM sûrs, noms de requête stables). */
export const CONTACT_FIELD_NAME_PATTERN = CONTACT_KEY_PATTERN;
export const CONTACT_FIELD_NAME_MAX_LENGTH = 60;

// ——— Payload ———

/** Taille maximale du JSONB stocké — borne anti-abus, pas une règle éditoriale. */
export const CONTACT_PAYLOAD_MAX_BYTES = 32 * 1024;

// ——— Jeton d'émission du formulaire (anti-spam, anti-replay borné) ———

/** Nom du champ caché portant le jeton d'émission. */
export const FORM_TOKEN_FIELD = 'form_token';
/**
 * Âge minimal du jeton à la soumission (secondes) — un remplissage
 * « instantané » est un signal de bot. Sur une page statique le jeton est
 * émis au build : la borne est trivialement satisfaite ; elle devient
 * réellement discriminante quand le HTML est servi à la demande (re-rendu
 * d'erreurs, page SSR du Project) — et l'E2E l'exerce sur le dev server.
 */
export const FORM_MIN_FILL_SECONDS = 3;
/**
 * Âge maximal du jeton — un formulaire a été rendu par un build : au-delà,
 * la soumission est refusée avec une consigne de rechargement (le site doit
 * être reconstruit de toute façon). Aligné sur la limite absolue des sessions.
 */
export const FORM_TOKEN_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

// ——— Rate limiting (cadrage §23.5 : formulaires ~5 / 10 min / hash d'IP) ———

export const CONTACT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const CONTACT_RATE_LIMIT_MAX = 5;
/** Préfixe des clés de rate limiting des formulaires publics. */
export function contactRateLimitKey(formKey: string, ipHash: string): string {
  return `contact:${formKey}:${ipHash}`;
}

// ——— Idempotence (doubles soumissions) ———

/**
 * Fenêtre d'idempotence : deux soumissions de même contenu, même client
 * (hash d'IP) et même tranche temporelle produisent **une seule** demande.
 * Le client n'est jamais cru sur un jeton d'idempotence qu'il générerait :
 * la clé est calculée serveur (HMAC) — voir services/contact.ts.
 */
export const CONTACT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// ——— Notification ———

export const CONTACT_NOTIFICATION_SUBJECT_MAX_LENGTH = 200;
export const CONTACT_RECIPIENTS_MAX = 5;
/** États de notification d'une demande. */
export const contactNotificationStatuses = ['not_configured', 'pending', 'sent', 'failed'] as const;
export type ContactNotificationStatus = (typeof contactNotificationStatuses)[number];
/** Tentatives maximales avant intervention humaine (l'admin relance depuis la boîte). */
export const CONTACT_NOTIFICATION_MAX_ATTEMPTS = 5;
/**
 * Backoff des re-tentatives automatiques, indexé par numéro de tentative
 * échouée (1 → +2 min, 2 → +10 min, 3 → +1 h, 4 → +6 h ; au-delà, échec
 * terminal jusqu'à relance admin). Le balayage de rattrapage (cron futur)
 * reprend `pending`/`failed` dont `notification_next_attempt_at` est due.
 */
export const CONTACT_NOTIFICATION_BACKOFF_MS = [
  2 * 60 * 1000,
  10 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
] as const;

export function contactNotificationBackoffMs(failedAttempt: number): number {
  const index = Math.min(Math.max(failedAttempt, 1), CONTACT_NOTIFICATION_BACKOFF_MS.length) - 1;
  return CONTACT_NOTIFICATION_BACKOFF_MS[index]!;
}

// ——— Validators purs ———

const EMAIL_LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

/**
 * Adresse email destinataire/émetteur — stricte et **sûre en en-tête** :
 * un seul @, pas d'espaces, pas de caractères de contrôle (CR/LF/NUL) ni
 * d'obscurcissement par tabulation. C'est la barrière anti-injection
 * d'en-têtes : toute valeur d'en-tête du mail (To, From, Reply-To,
 * Subject) passe ou passe par cette famille de validators.
 */
export function isSafeEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/[\r\n\0\t\v\f\u0085\u2028\u2029]/.test(value)) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!EMAIL_LOCAL_PART.test(local)) return false;
  // Domaine : labels alphanumériques/hyphens, au moins un point (FQDN
  // requis — on n'envoie jamais vers un domaine nu).
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) {
    return false;
  }
  return true;
}

/**
 * Valeur d'en-tête textuelle sûre (subject, noms d'affichage) — interdit
 * CR/LF/NUL et tout caractère de contrôle : un sujet déclaré contenant un
 * saut de ligne est une erreur de déclaration, jamais un header injecté.
 */
export function isSafeHeaderValue(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Chemin interne de confirmation — page **du même site**, jamais une URL
 * absolue ni une URL protocol-relative : la redirection post-soumission ne
 * peut pas quitter le domaine (anti open-redirect).
 */
export function isInternalConfirmationPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (/[\r\n\0]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value.slice(1))) return false;
  return true;
}

/**
 * Endpoint public de soumission d'un formulaire — hors `/admin` (invariant
 * du cookie de session : le visiteur n'a jamais de session admin) et
 * déterministe pour être relié au `action` du rendu. La clé est déjà
 * contrainte par `CONTACT_KEY_PATTERN` à la déclaration ; l'encodage reste
 * défensif.
 */
export function publicFormSubmitPath(formKey: string): string {
  return `/api/forms/${encodeURIComponent(formKey)}`;
}
