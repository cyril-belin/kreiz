import { adminAuditLog } from './tables/admin-audit-log.js';
import { adminSessions } from './tables/admin-sessions.js';
import { adminUsers } from './tables/admin-users.js';
import { analyticsEvents } from './tables/analytics-events.js';
import { contactRequests } from './tables/contact-requests.js';
import { contentEntries } from './tables/content-entries.js';
import { media } from './tables/media.js';
import { rateLimits } from './tables/rate-limits.js';
import { redirects } from './tables/redirects.js';

/**
 * Les neuf tables du Core, préfixe `kreiz_` **figé en V1** (cadrage §23.3).
 *
 * Les définitions sont des singletons de module : `defineCoreTables()` retourne
 * toujours **les mêmes instances**. C'est délibéré — l'application qui compose
 * son schéma et les repositories du Core qui interrogent ces tables partagent
 * les mêmes objets Drizzle, ce qui évite plusieurs instances incohérentes des
 * mêmes tables (un paramétrage par appel créerait ce risque sans besoin
 * démontré ; voir cadrage §2.6 — simplicité d'abord).
 */
const kreizCoreTables = Object.freeze({
  adminUsers,
  adminSessions,
  adminAuditLog,
  contentEntries,
  redirects,
  media,
  contactRequests,
  analyticsEvents,
  rateLimits,
});

export type CoreTables = Readonly<{
  adminUsers: typeof adminUsers;
  adminSessions: typeof adminSessions;
  adminAuditLog: typeof adminAuditLog;
  contentEntries: typeof contentEntries;
  redirects: typeof redirects;
  media: typeof media;
  contactRequests: typeof contactRequests;
  analyticsEvents: typeof analyticsEvents;
  rateLimits: typeof rateLimits;
}>;

export { kreizCoreTables };
