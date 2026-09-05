import { csrfTokensMatch, deriveSessionCsrfToken } from '../services/auth-tokens.js';

/**
 * CSRF lié à la session (cadrage §16) — **pas** un double-submit cookie.
 *
 * Le token est dérivé du token de session brut (HMAC-SHA256) : il est
 * imprévisible sans le cookie HttpOnly, cryptographiquement lié à la
 * session (il change à chaque session — « renouvelé lorsque la session
 * change »), et vérifiable côté serveur sans stockage additionnel.
 *
 * API pour les futurs slices : toute mutation admin rend
 * `<input type="hidden" name="csrf_token" value={csrfToken}>` (csrfToken
 * fourni par le guard) et vérifie la soumission avec
 * `verifySessionCsrfToken(sessionToken, formData.get('csrf_token'))`.
 * Les GET restent sans effet de bord.
 */
export const CSRF_FORM_FIELD = 'csrf_token';

/** Vérifie un token CSRF soumis contre la session courante (temps constant). */
export function verifySessionCsrfToken(
  sessionToken: string,
  submitted: string | undefined | null,
): boolean {
  if (!submitted) return false;
  return csrfTokensMatch(deriveSessionCsrfToken(sessionToken), submitted);
}
