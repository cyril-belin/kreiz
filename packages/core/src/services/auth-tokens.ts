import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Primitives de tokens d'authentification — Node crypto uniquement.
 *
 * - **Token de session** : 32 octets aléatoires cryptographiquement sûrs
 *   (256 bits d'entropie), encodés base64url. Le token brut vit
 *   exclusivement dans le cookie ; la base ne stocke que son hash SHA-256
 *   (l'entropie du token rend la précalculabilité d'un SHA-256 public
 *   sans objet).
 * - **Token CSRF** : dérivé du token de session par HMAC-SHA256. Il est
 *   imprévisible (impossible à connaître sans le cookie HttpOnly),
 *   cryptographiquement lié à la session (il change à chaque session),
 *   vérifiable côté serveur sans stockage additionnel — pas de migration
 *   de schéma pour lui.
 * - **Pseudonymisation d'IP** : HMAC-SHA256 avec le secret de déploiement
 *   (`KREIZ_SECRET`) — jamais un SHA public recalculable, jamais l'IP
 *   complète persistée.
 */

const SESSION_TOKEN_BYTES = 32;

/** Génère un token de session brut (base64url, 43 caractères). */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** Hash SHA-256 (hex) d'un token de session — forme stockée en base. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Longueur attendue d'un token brut (contrôle rapide avant lookup DB). */
export function isPlausibleSessionToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && token.length === 43;
}

const CSRF_DERIVATION_LABEL = 'kreiz:csrf:v1';

/** Dérive le token CSRF lié à une session (HMAC-SHA256, clé = token brut). */
export function deriveSessionCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_DERIVATION_LABEL).digest('hex');
}

/** Comparaison à temps constant de deux tokens CSRF. */
export function csrfTokensMatch(expected: string, submitted: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(submitted, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const IP_PSEUDONYM_LABEL = 'kreiz:login-ip:v1';

/**
 * Pseudonymise une IP pour le rate limiting : HMAC-SHA256 secret-keyed.
 * Sans le secret de déploiement, l'IP d'origine est irrécupérable
 * (l'espace IPv4 est petit — un hash public sans clé serait
 * rétro-calculable). L'IP complète n'est jamais persistée.
 */
export function pseudonymizeIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`${IP_PSEUDONYM_LABEL}:${ip}`).digest('hex');
}
