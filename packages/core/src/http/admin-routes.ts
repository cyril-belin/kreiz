/**
 * Namespace de routes du back-office — **invariant du cookie de session**.
 *
 * Le cookie `kreiz_admin_session` est émis avec `Path=/admin` : le
 * navigateur ne l'envoie jamais avec les requêtes du site public. Ce
 * bénéfice impose la règle suivante aux slices futurs :
 *
 * > **Toute route nécessitant la session admin doit vivre sous `/admin/*`**
 * > (pages, endpoints d'action, `/admin/api/...`). Les endpoints publics
 * > (`/api/forms/<key>`, `/api/analytics`…) restent hors `/admin`, sont
 * > listés dans `PUBLIC_ROUTE_PATTERNS` (garde mécanique : jamais sous le
 * > préfixe) et ne dépendent jamais de la session admin.
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

// ——— Médias (slice 5) — pages, mutations POST et endpoints JSON, tous SSR sous /admin ———

/** Médiathèque : grille, upload présigné, alt, retry, suppression. */
export const ADMIN_MEDIA_PATH = '/admin/media';
/**
 * Demande d'upload — POST JSON authentifié (session + CSRF + same-origin,
 * mission §37 : **jamais** d'endpoint public de présignature). Le fichier
 * lui-même part ensuite directement du navigateur vers le stockage.
 */
export const ADMIN_MEDIA_UPLOAD_REQUEST_PATH = '/admin/media/upload-request';
/** Confirmation post-upload — POST JSON (vérification serveur de l'objet réel). */
export const ADMIN_MEDIA_CONFIRM_PATTERN = '/admin/media/[id]/confirm';
/** Polling de statut — GET JSON (uploading/processing/ready/failed). */
export const ADMIN_MEDIA_STATUS_PATTERN = '/admin/media/[id]/status';
/** Alt text — mutation POST (formulaire progressif). */
export const ADMIN_MEDIA_ALT_PATTERN = '/admin/media/[id]/alt';
/** Retry d'un média failed — mutation POST. */
export const ADMIN_MEDIA_RETRY_PATTERN = '/admin/media/[id]/retry';
/** Suppression (référencé = refusé, mission §26) — mutation POST. */
export const ADMIN_MEDIA_DELETE_PATTERN = '/admin/media/[id]/delete';

// ——— Formulaires / boîte de contact (slice 7) — toutes SSR sous /admin ———

/** Boîte de contact : liste des demandes (`?status=new` pour les non traitées). */
export const ADMIN_FORMS_PATH = '/admin/forms';
/** Détail d'une demande (payload, état de notification, actions). */
export const ADMIN_FORM_DETAIL_PATTERN = '/admin/forms/[id]';
/** Transition `new` ⇄ `handled` — mutation POST. */
export const ADMIN_FORM_STATUS_PATTERN = '/admin/forms/[id]/status';
/** Relance de la notification email — mutation POST. */
export const ADMIN_FORM_NOTIFY_PATTERN = '/admin/forms/[id]/notify';

// ——— Analytics (slice 8) — page admin + routes publiques ———

/** Dashboard analytics admin : agrégations 7/30/90 jours, aucun chart lourd. */
export const ADMIN_ANALYTICS_PATH = '/admin/analytics';

/**
 * Endpoint public de collecte (beacon) — hors `/admin`, sans session admin,
 * POST JSON strictement borné. Liste `PUBLIC_ROUTE_PATTERNS` (garde
 * mécanique), jamais sous le préfixe.
 */
export const PUBLIC_ANALYTICS_EVENT_PATTERN = '/api/analytics/event';
/**
 * Fichier beacon — route **prérendue** (fichier statique au build, CDN) :
 * mesurer le site public n'ajoute aucun runtime dynamique au chemin critique.
 */
export const PUBLIC_ANALYTICS_BEACON_PATTERN = '/api/analytics/beacon.js';
/** Alias lisible du chemin du beacon pour les helpers publics. */
export const PUBLIC_ANALYTICS_BEACON_PATH = PUBLIC_ANALYTICS_BEACON_PATTERN;

// ——— Endpoint PUBLIC de soumission (slice 7) — hors /admin, sans session ———

/**
 * **Route publique** : `/api/forms/[key]` (cadrage §5 — POST formulaires ;
 * cadrage §2/§10 : le cookie de session admin vit sous `Path=/admin`, une
 * route publique doit donc vivre **hors** du préfixe et ne dépend jamais de
 * la session). Liste séparée de `ADMIN_ROUTE_PATTERNS`, garde mécanique
 * dédiée dans `tests/admin-routes.test.ts`.
 */
export const PUBLIC_FORM_SUBMIT_PATTERN = '/api/forms/[key]';

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
  ADMIN_MEDIA_PATH,
  ADMIN_MEDIA_UPLOAD_REQUEST_PATH,
  ADMIN_MEDIA_CONFIRM_PATTERN,
  ADMIN_MEDIA_STATUS_PATTERN,
  ADMIN_MEDIA_ALT_PATTERN,
  ADMIN_MEDIA_RETRY_PATTERN,
  ADMIN_MEDIA_DELETE_PATTERN,
  ADMIN_FORMS_PATH,
  ADMIN_FORM_DETAIL_PATTERN,
  ADMIN_FORM_STATUS_PATTERN,
  ADMIN_FORM_NOTIFY_PATTERN,
  ADMIN_ANALYTICS_PATH,
] as const;

/** Patterns des routes **publiques** injectées par l'intégration (jamais sous /admin). */
export const PUBLIC_ROUTE_PATTERNS = [
  PUBLIC_FORM_SUBMIT_PATTERN,
  PUBLIC_ANALYTICS_EVENT_PATTERN,
  PUBLIC_ANALYTICS_BEACON_PATTERN,
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

// ——— Constructeurs d'URL médias (slice 5) ———

export function adminMediaConfirmPath(mediaId: string): string {
  return `${ADMIN_MEDIA_PATH}/${encodeURIComponent(mediaId)}/confirm`;
}

export function adminMediaStatusPath(mediaId: string): string {
  return `${ADMIN_MEDIA_PATH}/${encodeURIComponent(mediaId)}/status`;
}

export function adminMediaAltPath(mediaId: string): string {
  return `${ADMIN_MEDIA_PATH}/${encodeURIComponent(mediaId)}/alt`;
}

export function adminMediaRetryPath(mediaId: string): string {
  return `${ADMIN_MEDIA_PATH}/${encodeURIComponent(mediaId)}/retry`;
}

export function adminMediaDeletePath(mediaId: string): string {
  return `${ADMIN_MEDIA_PATH}/${encodeURIComponent(mediaId)}/delete`;
}

// ——— Constructeurs d'URL boîte de contact (slice 7) ———

export function adminFormDetailPath(requestId: string): string {
  return `${ADMIN_FORMS_PATH}/${encodeURIComponent(requestId)}`;
}

export function adminFormStatusPath(requestId: string): string {
  return `${adminFormDetailPath(requestId)}/status`;
}

export function adminFormNotifyPath(requestId: string): string {
  return `${adminFormDetailPath(requestId)}/notify`;
}
