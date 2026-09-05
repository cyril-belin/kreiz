import { ADMIN_ROUTE_PREFIX } from './admin-routes.js';

/**
 * Cookie de session admin — nom namespacé Kreiz, durci par défaut.
 *
 * Le token brut (256 bits) vit uniquement ici, dans un cookie HttpOnly :
 * jamais accessible au JavaScript, jamais dans localStorage/sessionStorage.
 * `Secure` uniquement en production (le dev local tourne en HTTP).
 * `Path=/admin` (invariant : voir `admin-routes.ts`) : le cookie n'est plus
 * envoyé sur le site public — toute route consommant la session doit donc
 * vivre sous `/admin/*`.
 */
export const ADMIN_SESSION_COOKIE_NAME = 'kreiz_admin_session';
/** Chemin du cookie = préfixe des routes admin — ne jamais élargir à `/`. */
export const ADMIN_COOKIE_PATH = ADMIN_ROUTE_PREFIX;

export type AdminSessionCookieOptions = {
  /** Durée de vie en secondes, alignée sur `expires_at` de la session. */
  maxAgeSeconds: number;
  /** `true` en production (réponse Astro `import.meta.env.PROD`). */
  secure: boolean;
};

/** Options à passer à `Astro.cookies.set()` (pages et endpoints). */
export function adminSessionCookieOptions(options: AdminSessionCookieOptions) {
  return {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: ADMIN_COOKIE_PATH,
    maxAge: Math.max(1, Math.ceil(options.maxAgeSeconds)),
  } as const;
}

/** Invalidation : la réponse doit supprimer le cookie côté navigateur. */
export function adminSessionCookieClearOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: ADMIN_COOKIE_PATH,
    maxAge: 0,
  } as const;
}
