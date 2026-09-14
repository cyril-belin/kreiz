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
 * que **chaque** route injectée respecte le préfixe (la route spike publique
 * du slice 0 a été supprimée au slice 3 : plus aucune route injectée hors
 * `/admin`) et que le chemin du cookie reste exactement ce préfixe.
 */

export const ADMIN_ROUTE_PREFIX = '/admin';

export const ADMIN_HOME_PATH = '/admin';
export const ADMIN_LOGIN_PATH = '/admin/login';
export const ADMIN_LOGOUT_PATH = '/admin/logout';

// ——— Moteur de contenu (slice 3) — pages et mutations, toutes SSR sous /admin ———

export const ADMIN_CONTENT_INDEX_PATH = '/admin/content';
/** Listing d'un type déclaré : `/admin/content/[type]` (type = clé déclarée). */
export const ADMIN_CONTENT_TYPE_PATTERN = '/admin/content/[type]';
/** Création : `/admin/content/[type]/new` (segment statique, prioritaire sur [id]). */
export const ADMIN_CONTENT_NEW_PATTERN = '/admin/content/[type]/new';
/** Édition d'un brouillon : `/admin/content/[type]/[id]`. */
export const ADMIN_CONTENT_EDIT_PATTERN = '/admin/content/[type]/[id]';
/** Soft delete — mutation POST dédiée (jamais de GET destructeur). */
export const ADMIN_CONTENT_DELETE_PATTERN = '/admin/content/[type]/[id]/delete';
/** Publication — mutation POST dédiée (slice 4). */
export const ADMIN_CONTENT_PUBLISH_PATTERN = '/admin/content/[type]/[id]/publish';
/** Dépublication — mutation POST dédiée (slice 4). */
export const ADMIN_CONTENT_UNPUBLISH_PATTERN = '/admin/content/[type]/[id]/unpublish';
/** Preview SSR d'un brouillon avec le vrai template du Project. */
export const ADMIN_PREVIEW_PATTERN = '/admin/preview/[id]';

// ——— Reconstruction du site (slice 4) ———

/** Rebuild manuel — mutation POST authentifiée, même port `RebuildTrigger`. */
export const ADMIN_REBUILD_PATH = '/admin/rebuild';

/** Patterns des routes admin injectées par l'intégration (tous sous le préfixe). */
export const ADMIN_ROUTE_PATTERNS = [
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_LOGOUT_PATH,
  ADMIN_CONTENT_INDEX_PATH,
  ADMIN_CONTENT_TYPE_PATTERN,
  ADMIN_CONTENT_NEW_PATTERN,
  ADMIN_CONTENT_EDIT_PATTERN,
  ADMIN_CONTENT_DELETE_PATTERN,
  ADMIN_CONTENT_PUBLISH_PATTERN,
  ADMIN_CONTENT_UNPUBLISH_PATTERN,
  ADMIN_PREVIEW_PATTERN,
  ADMIN_REBUILD_PATH,
] as const;

// ——— Constructeurs d'URL admin (pages et formulaires) ———

export function adminContentTypePath(contentTypeKey: string): string {
  return `${ADMIN_CONTENT_INDEX_PATH}/${encodeURIComponent(contentTypeKey)}`;
}

export function adminContentNewPath(contentTypeKey: string): string {
  return `${adminContentTypePath(contentTypeKey)}/new`;
}

export function adminContentEditPath(contentTypeKey: string, entryId: string): string {
  return `${adminContentTypePath(contentTypeKey)}/${encodeURIComponent(entryId)}`;
}

export function adminContentDeletePath(contentTypeKey: string, entryId: string): string {
  return `${adminContentEditPath(contentTypeKey, entryId)}/delete`;
}

export function adminContentPublishPath(contentTypeKey: string, entryId: string): string {
  return `${adminContentEditPath(contentTypeKey, entryId)}/publish`;
}

export function adminContentUnpublishPath(contentTypeKey: string, entryId: string): string {
  return `${adminContentEditPath(contentTypeKey, entryId)}/unpublish`;
}

export function adminPreviewPath(entryId: string): string {
  return `/admin/preview/${encodeURIComponent(entryId)}`;
}
