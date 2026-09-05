import { check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const kreizContactRequestStatuses = ['new', 'handled'] as const;
export type KreizContactRequestStatus = (typeof kreizContactRequestStatuses)[number];

/**
 * Demandes de contact. `payload` est validé par le schéma Zod du formulaire
 * déclaré en code (cadrage §13), pas au niveau SQL. Pas d'IP complète,
 * pas d'User-Agent brut. Endpoint public et boîte admin : slices 7/8 —
 * table seule ici.
 */
export const contactRequests = pgTable(
  'kreiz_contact_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    formId: text('form_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<KreizContactRequestStatus>().notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'kreiz_contact_requests_status_check',
      sql`${table.status} in ('new', 'handled')`,
    ),
  ],
);

export type KreizContactRequest = typeof contactRequests.$inferSelect;
export type KreizContactRequestInsert = typeof contactRequests.$inferInsert;
