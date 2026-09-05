/**
 * API publique data de Kreiz — sous-chemin `@kreiz/core/data`.
 *
 * C'est la seule porte vers la couche data : définitions de tables
 * (`defineCoreTables`), connexion serveur Neon/Drizzle, repositories.
 * Toute l'arborescence interne (`src`, `dist`) reste inaccessible par la
 * carte `exports` du package — la frontière du slice 0 reste intacte.
 */

// Tables & composition
export { defineCoreTables } from './define-core-tables.js';
export type { CoreTables } from './core-tables.js';

// Événements/vocabulaires du schéma (utiles aux apps sans dupliquer les unions)
export { kreizContentStatuses, type KreizContentStatus } from './tables/content-entries.js';
export type { KreizContentSeo } from './tables/content-entries.js';
export { kreizMediaStatuses, type KreizMediaStatus } from './tables/media.js';
export type { KreizMediaVariant } from './tables/media.js';
export {
  kreizContactRequestStatuses,
  type KreizContactRequestStatus,
} from './tables/contact-requests.js';
export {
  kreizAnalyticsEventNames,
  type KreizAnalyticsEventName,
} from './tables/analytics-events.js';
export { kreizDeviceClasses, type KreizDeviceClass } from './tables/analytics-events.js';

// Types de lignes (select) et d'écriture (insert), dérivés des définitions Drizzle
export type { KreizAdminUser, KreizAdminUserInsert } from './tables/admin-users.js';
export type { KreizAdminSession, KreizAdminSessionInsert } from './tables/admin-sessions.js';
export type { KreizAdminAuditLog, KreizAdminAuditLogInsert } from './tables/admin-audit-log.js';
export type { KreizContentEntry, KreizContentEntryInsert } from './tables/content-entries.js';
export type { KreizRedirect, KreizRedirectInsert } from './tables/redirects.js';
export type { KreizMedia, KreizMediaInsert } from './tables/media.js';
export type { KreizContactRequest, KreizContactRequestInsert } from './tables/contact-requests.js';
export type { KreizAnalyticsEvent, KreizAnalyticsEventInsert } from './tables/analytics-events.js';
export type { KreizRateLimit, KreizRateLimitInsert } from './tables/rate-limits.js';

// Connexion serveur
export { createKreizDatabase, type KreizDatabase, type KreizDatabaseOptions } from './connection.js';
export { kreizDatabaseEnvSchema, parseKreizDatabaseEnv, type KreizDatabaseEnv } from './env.js';

// Repositories — seule frontière autorisée à parler à Drizzle/Neon pour le domaine Kreiz
export {
  createAdminUsersRepository,
  type AdminUsersRepository,
} from './repositories/admin-users.js';
export {
  createContentEntriesRepository,
  type ContentEntriesRepository,
} from './repositories/content-entries.js';
export { createRedirectsRepository, type RedirectsRepository } from './repositories/redirects.js';
