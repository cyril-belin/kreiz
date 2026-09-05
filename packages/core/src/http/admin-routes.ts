/**
 * Namespace de routes du back-office — **invariant du cookie de session**.
 *
 * Le cookie `kreiz_admin_session` est émis avec `Path=/admin` : le
 * navigateur ne l'envoie jamais avec les requêtes du site public. Ce
 * bénéfice impose la règle suivante aux slices futurs :
 *
 * > **Toute route nécessitant la session admin doit vivre sous `/admin/*`**
 * > (pages, endpoints d'action, `/admin/api/...`). Les endpoints publics
 * > (`/api/contact`, `/api/analytics`…) restent hors `/admin` et ne
 * > dépendent jamais de la session admin.
 *
 * Les patterns de routes injectées sont déclarés ici et consommés par
 * l'intégration ; le test garde `admin-routes.test.ts` vérifie mécaniquement
 * que chaque route injectée respecte le préfixe et que le chemin du cookie
 * reste exactement ce préfixe (jamais `Path=/`).
 */
export const ADMIN_ROUTE_PREFIX = '/admin';

export const ADMIN_HOME_PATH = '/admin';
export const ADMIN_LOGIN_PATH = '/admin/login';
export const ADMIN_LOGOUT_PATH = '/admin/logout';

/** Patterns des routes admin injectées par l'intégration (tous sous le préfixe). */
export const ADMIN_ROUTE_PATTERNS = [ADMIN_HOME_PATH, ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH] as const;
