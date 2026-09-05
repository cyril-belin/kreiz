import type { KreizAdminSession } from '../data/tables/admin-sessions.js';
import type { KreizAdminUser } from '../data/tables/admin-users.js';
import type { AdminAuthService } from '../services/admin-auth.js';
import { ADMIN_SESSION_COOKIE_NAME } from './cookies.js';

/**
 * Guards admin réutilisables (cadrage §6 — couche http).
 *
 * Ils distinguent les quatre états requis par le slice : aucune session,
 * session invalide/expirée, session révoquée, admin désactivé — et restent
 * purs côté décision : la réponse web (redirect) ou API (JSON) est
 * construite par la route à partir du résultat. Ils ne requêtent jamais
 * Neon directement : ils reçoivent le service d'auth.
 */
export type AdminAccess =
  | {
      kind: 'authenticated';
      admin: KreizAdminUser;
      session: KreizAdminSession;
      /** Token CSRF lié à la session — à rendre dans chaque formulaire admin. */
      csrfToken: string;
      /** Durée de vie restante (s) — rafraîchit le cookie quand la session a été prolongée. */
      cookieMaxAgeSeconds: number;
    }
  | {
      kind: 'unauthenticated';
      reason: 'no-session' | 'invalid' | 'expired' | 'revoked' | 'admin-disabled';
    };

/** Extrait le token de session brut d'un objet cookies minimal (Astro.cookies). */
export function sessionTokenFromCookies(
  cookies: { get(name: string): { value: string } | undefined },
): string | null {
  return cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;
}

/** Décision de guard : valide la session et retourne l'accès effectif. */
export async function resolveAdminAccess(
  auth: Pick<AdminAuthService, 'resolveSession'>,
  cookieToken: string | undefined | null,
  options: { now?: Date } = {},
): Promise<AdminAccess> {
  if (!cookieToken) {
    return { kind: 'unauthenticated', reason: 'no-session' };
  }
  const resolution = await auth.resolveSession(cookieToken, options);
  if (resolution.status !== 'authenticated') {
    return { kind: 'unauthenticated', reason: resolution.status };
  }
  const now = options.now ?? new Date();
  return {
    kind: 'authenticated',
    admin: resolution.admin,
    session: resolution.session,
    csrfToken: resolution.csrfToken,
    cookieMaxAgeSeconds: Math.max(
      1,
      Math.ceil((resolution.session.expiresAt.getTime() - now.getTime()) / 1000),
    ),
  };
}

/** Statut HTTP d'un refus de guard pour un endpoint API admin (jamais du HTML de login). */
export function adminApiDenyStatus(reason: Exclude<AdminAccess, { kind: 'authenticated' }>['reason']): number {
  switch (reason) {
    case 'admin-disabled':
      return 403;
    case 'no-session':
    case 'invalid':
    case 'expired':
    case 'revoked':
    default:
      return 401;
  }
}
