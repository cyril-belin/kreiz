import { z } from 'zod';

/**
 * Règles pures du domaine auth — aucune I/O, aucun import Drizzle/Astro.
 *
 * Toutes les constantes de politique (durées de session, seuils, rate
 * limiting, mot de passe) sont fixées ici : elles appartiennent à la
 * politique de sécurité de Kreiz et ne sont pas configurables par projet
 * (cadrage §23 — défauts de travail validés).
 */

// ——— Sessions (cadrage §10 : 14 j glissants, limite absolue 90 j) ———

/** Expiration glissante : durée d'inactivité avant expiration. */
export const SESSION_SLIDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Limite absolue : durée de vie maximale depuis la création. */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Seuil de rafraîchissement : `last_seen_at` n'est réécrit (et
 * `expires_at` prolongé) que si la dernière activité date de plus que ce
 * seuil — évite une écriture DB par requête sans sacrifier la glissière.
 */
export const SESSION_TOUCH_THRESHOLD_MS = 60 * 60 * 1000;

// ——— Rate limiting login (cadrage §23.5 : 5 échecs / 15 min) ———

export const LOGIN_RATE_LIMIT_MAX = 5;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/** Fenêtres plus vieilles que cet horizon sont purgées de façon opportuniste. */
export const RATE_LIMIT_PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

// ——— Politique de mot de passe ———

/**
 * Longueur minimale requise (NIST SP 800-63B : privilégier la longueur,
 * pas de règles de composition artificielles — pas de majuscule/symbole
 * obligatoire). Le maximum borne les entrées abusives.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Refus des valeurs manifestement inadéquates — ce n'est pas un filtrage
 * HIBP, juste une barrière minimale :
 * - correspondance exacte (marches de clavier, variantes usuelles) ;
 * - « cœur » de mot de passe compromis suivi de chiffres uniquement
 *   (couvre password123456, admin2026, motdepasse2026…).
 * La comparaison est insensible à la casse.
 */
const INADEQUATE_EXACT = new Set([
  'password',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'qwertyuiop',
  'qwertyuiopasdfgh',
  'azerty123',
  'azertyuiop',
  'azertyuiopqsd',
  'letmein123',
  'welcome123',
  'iloveyou123',
  'motdepasse',
]);

const INADEQUATE_CORES = ['password', 'motdepasse', 'letmein', 'welcome', 'admin', 'iloveyou'];

function isInadequatePassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (INADEQUATE_EXACT.has(lower)) return true;
  return INADEQUATE_CORES.some((core) => {
    if (!lower.startsWith(core)) return false;
    const rest = lower.slice(core.length);
    return rest === '' || /^\d+$/.test(rest);
  });
}

export type PasswordIssue = {
  /** Code stable, exploitable par l'appelant (CLI, futur admin). */
  code: 'too-short' | 'too-long' | 'inadequate' | 'contains-email';
  /** Message en français, prêt à afficher. */
  message: string;
};

/**
 * Politique de mot de passe V1 : longueur minimale, longueur maximale,
 * refus des valeurs manifestement inadéquates et du email en clair.
 * Aucune règle de composition artificielle.
 */
export function validatePasswordPolicy(
  password: string,
  context?: { email?: string },
): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push({
      code: 'too-short',
      message: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push({
      code: 'too-long',
      message: `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX_LENGTH} caractères.`,
    });
  }
  if (isInadequatePassword(password)) {
    issues.push({
      code: 'inadequate',
      message: 'Ce mot de passe est trop courant pour être utilisé.',
    });
  }
  const email = context?.email ? normalizeAdminEmail(context.email) : null;
  const emailLocal = email?.split('@')[0] ?? '';
  // Comparé au local-part uniquement, et seulement s'il est assez long
  // pour être significatif (un « a@… » matcherait partout).
  if (emailLocal.length >= 3 && password.toLowerCase().includes(emailLocal)) {
    issues.push({
      code: 'contains-email',
      message: 'Le mot de passe ne doit pas contenir l’adresse email.',
    });
  }
  return issues;
}

export function isPasswordAcceptable(password: string, context?: { email?: string }): boolean {
  return validatePasswordPolicy(password, context).length === 0;
}

// ——— Email ———

/**
 * Normalisation pour unicité : trim + minuscules. Les emails sont stockés
 * et comparés normalisés (le rate limiting par email utilise la même
 * normalisation pour éviter de contourner le compteur par la casse).
 */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

const adminEmailSchema = z.email().max(320);

/** Normalise puis valide un email d'admin — `null` si le format est invalide. */
export function parseAdminEmail(input: string): string | null {
  const normalized = normalizeAdminEmail(input);
  return adminEmailSchema.safeParse(normalized).success ? normalized : null;
}

// ——— Validation des entrées de login ———

export const loginInputSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

/**
 * Valide une soumission de login. Retourne `null` si la forme est
 * invalide : l'appelant doit produire un message **générique** équivalent
 * à « identifiants invalides » (anti-énumération).
 */
export function parseLoginInput(input: unknown): LoginInput | null {
  const parsed = loginInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// ——— Expiration des sessions (pures, testables sans DB) ———

export type SessionExpirySnapshot = {
  revokedAt: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
};

export type SessionExpiryCheck =
  | { valid: true }
  | { valid: false; reason: 'revoked' | 'sliding-expired' | 'absolute-expired' };

/** Vérifie uniquement la dimension temporelle/révocation d'une session. */
export function checkSessionExpiry(
  session: SessionExpirySnapshot,
  now: Date,
): SessionExpiryCheck {
  if (session.revokedAt) {
    return { valid: false, reason: 'revoked' };
  }
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) {
    return { valid: false, reason: 'absolute-expired' };
  }
  if (now.getTime() >= session.expiresAt.getTime()) {
    return { valid: false, reason: 'sliding-expired' };
  }
  return { valid: true };
}

export type SessionWindow = {
  /** Fenêtre glissante à la création : `now` + 14 j. */
  expiresAt: Date;
  /** Limite absolue à la création : `now` + 90 j. */
  absoluteExpiresAt: Date;
};

/** Fenêtres d'expiration d'une nouvelle session, à partir de `now`. */
export function sessionWindowFor(now: Date): SessionWindow {
  return {
    expiresAt: new Date(now.getTime() + SESSION_SLIDING_TTL_MS),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
  };
}

export type SessionTouch = {
  lastSeenAt: Date;
  expiresAt: Date;
};

/**
 * Calcule le rafraîchissement glissant d'une session utilisée :
 * si `last_seen_at` est suffisamment ancien, propage `last_seen_at` à
 * `now` et prolonge `expires_at` à `min(now + 14 j, limite absolue)`.
 * Retourne `null` quand rien ne doit être écrit (seuil non atteint ou
 * prolongement sans effet).
 */
export function sessionTouch(
  session: { lastSeenAt: Date; expiresAt: Date; absoluteExpiresAt: Date },
  now: Date,
): SessionTouch | null {
  if (now.getTime() - session.lastSeenAt.getTime() < SESSION_TOUCH_THRESHOLD_MS) {
    return null;
  }
  // Invariant : expires_at ≤ last_seen_at + 14 j. Le seuil étant atteint,
  // `now + 14 j` prolonge donc toujours la fenêtre (bornée par l'absolue).
  return {
    lastSeenAt: now,
    expiresAt: new Date(
      Math.min(now.getTime() + SESSION_SLIDING_TTL_MS, session.absoluteExpiresAt.getTime()),
    ),
  };
}

// ——— Clés de rate limiting ———

/**
 * Construit la clé de compteur login pour une identité déjà
 * pseudonymisée par l'appelant (le hash HMAC appartient à la couche
 * services — le domaine ne connaît que le format de clé).
 */
export function loginRateLimitKey(scope: 'email' | 'ip', pseudonym: string): string {
  return `kreiz:login:v1:${scope}:${pseudonym}`;
}
