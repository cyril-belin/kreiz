import type { AdminAuthService } from '../services/admin-auth.js';
import { isTrustedSameSiteMutation } from './mutations.js';

/**
 * Orchestration HTTP du formulaire de login (page `/admin/login`).
 *
 * Sépare la logique de la présentation : la page .astro appelle
 * `processLoginSubmission()` et rend soit un redirect (succès), soit le
 * formulaire avec un message **générique** (anti-énumération) — l'email
 * saisi est préservé, le mot de passe n'est jamais republié ni rendu.
 */

export const LOGIN_GENERIC_ERROR = 'Email ou mot de passe invalide.';
export const LOGIN_RATE_LIMIT_ERROR =
  'Trop de tentatives. Attendez quelques minutes avant de réessayer.';
export const LOGIN_FORBIDDEN_ERROR = 'Requête refusée.';

export type LoginViewData = {
  /** Email à re-rendre dans le champ (jamais le mot de passe). */
  email: string;
  error: string | null;
};

export type LoginSubmissionResult =
  | {
      kind: 'success';
      /** Token de session brut — à placer dans le cookie HttpOnly. */
      sessionToken: string;
      cookieMaxAgeSeconds: number;
    }
  | { kind: 'render'; view: LoginViewData; status: number };

/**
 * IP du client telle que fournie par la plateforme d'exécution. La valeur
 * n'est jamais persistée : elle est HMACée (secret serveur) pour la clé
 * de rate limiting. `x-real-ip` / `x-vercel-forwarded-for` sont posés par
 * la plateforme (non falsifiables par le client) ; `x-forwarded-for` ne
 * sert qu'en secours local.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const vercelForwarded = headers.get('x-vercel-forwarded-for');
  if (vercelForwarded) return vercelForwarded.split(',')[0]?.trim() || null;
  const forwardedFor = headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() || null;
}

/** Traite une soumission POST du formulaire de login. */
export async function processLoginSubmission(
  auth: Pick<AdminAuthService, 'login'>,
  request: Request,
  options: { now?: Date } = {},
): Promise<LoginSubmissionResult> {
  if (!isTrustedSameSiteMutation(request)) {
    return {
      kind: 'render',
      view: { email: '', error: LOGIN_FORBIDDEN_ERROR },
      status: 403,
    };
  }

  let email = '';
  let password = '';
  try {
    const formData = await request.formData();
    email = String(formData.get('email') ?? '');
    password = String(formData.get('password') ?? '');
  } catch {
    return {
      kind: 'render',
      view: { email: '', error: LOGIN_GENERIC_ERROR },
      status: 400,
    };
  }

  const outcome = await auth.login({ email, password }, {
    ip: clientIpFromHeaders(request.headers),
    now: options.now,
  });

  switch (outcome.kind) {
    case 'success': {
      return {
        kind: 'success',
        sessionToken: outcome.sessionToken,
        cookieMaxAgeSeconds: Math.max(
          1,
          Math.ceil((outcome.session.expiresAt.getTime() - (options.now ?? new Date()).getTime()) / 1000),
        ),
      };
    }
    case 'rate-limited':
      return { kind: 'render', view: { email, error: LOGIN_RATE_LIMIT_ERROR }, status: 429 };
    case 'invalid-credentials':
      return { kind: 'render', view: { email, error: LOGIN_GENERIC_ERROR }, status: 401 };
  }
}
