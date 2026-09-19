import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeIntegration,
  pgErrorCode,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/** Attend une erreur PostgreSQL précise d'une insertion (SQLSTATE). */
async function expectInsertError(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(pgErrorCode(error), `SQLSTATE attendu ${code}`).toBe(code);
    return;
  }
  throw new Error(`Erreur PostgreSQL ${code} attendue — aucune levée`);
}

/**
 * Test de migration **slice 8** : l'historique complet de `apps/demo`
 * (`0000 → 0005`) est rejoué dans un schéma isolé de la base réelle, et la
 * sémantique analytics y est vérifiée :
 * - colonnes ajoutées (`utm_*`, `locale`, `referrer_kind`, `dedup_key`),
 *   `session_id` devenue nullable ;
 * - vocabulaire fermé remplacé (`form_accepted`… admis, l'ancien
 *   `contact_form_submitted` rejeté — la table était vide par construction :
 *   aucun collecteur n'existait avant la slice 8) ;
 * - index unique **partiel** de déduplication réellement contraignant ;
 * - bornes de longueur en base (filet de sécurité) effectives.
 *
 * Aucune migration destructrice : la chaîne est purement additive
 * (ADD COLUMN nullable, DROP NOT NULL, contraintes, index).
 */
const runId = crypto.randomUUID().slice(0, 8);
const schema = `kreiz_analytics_mig_${runId}`;
const drizzleDir = fileURLToPath(new URL('../../../../apps/demo/drizzle', import.meta.url));

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const LAST = migrationFiles.at(-1);
if (LAST && !LAST.startsWith('0007')) {
  throw new Error(
    `@kreiz/core : la dernière migration attendue pour ce test est 0007 — trouvé « ${LAST} ». Mettre à jour analytics-migration.test.ts.`,
  );
}

function qualify(statement: string): string {
  return statement
    .replace(/(CREATE TABLE |ALTER TABLE |ON )"([^"]+)"/g, `$1"${schema}"."$2"`)
    .replace(/REFERENCES "public"\./g, `REFERENCES "${schema}".`);
}

async function applyAllMigrations(harness: IntegrationHarness): Promise<void> {
  for (const file of migrationFiles) {
    const content = readFileSync(`${drizzleDir}/${file}`, 'utf8');
    for (const statement of content.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue;
      await withTransientNetworkRetry(() => harness.raw(sql.raw(qualify(statement))));
    }
  }
}

describeIntegration('migration 0005 — kreiz_analytics_events (historique complet rejoué)', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`create schema if not exists "${schema}"`)),
    );
    await applyAllMigrations(harness);
  }, 120_000);

  afterAll(async () => {
    if (!harness) return;
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`drop schema if exists "${schema}" cascade`)),
    );
    await harness.close();
  });

  it('les colonnes slice 8 existent avec la bonne nullabilité', async () => {
    const rows = await harness.raw(
      sql`select column_name, is_nullable from information_schema.columns
          where table_schema = ${schema} and table_name = 'kreiz_analytics_events'
          order by column_name`,
    );
    const byName = new Map(rows.map((row) => [row.column_name as string, row.is_nullable === 'YES']));
    for (const column of ['referrer_kind', 'locale', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'dedup_key', 'referrer', 'device_class', 'country']) {
      expect(byName.get(column), column).toBe(true);
    }
    // Relaxation slice 8 : conversions serveur sans session navigateur.
    expect(byName.get('session_id')).toBe(true);
  });

  it('le vocabulaire fermé slice 8 est appliqué en base (ancien nom rejeté)', async () => {
    const insert = (eventName: string) =>
      harness.raw(
        sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path) values ('${eventName}', '/x')`),
      );
    for (const name of ['page_view', 'cta_click', 'form_accepted', 'form_notification_sent']) {
      await expect(insert(name)).resolves.toBeDefined();
    }
    await expect(insert('contact_form_submitted')).rejects.toThrow();
    await expect(insert('nom-libre-invente')).rejects.toThrow();
  });

  it('l’index unique partiel de déduplication arbitre réellement les doublons', async () => {
    const dedupKey = `mig-${runId}`;
    await harness.raw(
      sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path, dedup_key) values ('page_view', '/a', '${dedupKey}')`),
    );
    await expectInsertError(
      () =>
        harness.raw(
          sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path, dedup_key) values ('page_view', '/a', '${dedupKey}')`),
        ),
      '23505',
    );
    // NULL dedup_key : jamais d'arbitre (conversions serveur, événements hors session).
    await harness.raw(
      sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path) values ('form_accepted', '/b')`),
    );
    await harness.raw(
      sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path) values ('form_accepted', '/b')`),
    );
  });

  it('les bornes de longueur en base rejettent une charge dépassant les limites', async () => {
    await expectInsertError(
      () =>
        harness.raw(
          sql.raw(`insert into "${schema}".kreiz_analytics_events (event_name, path) values ('page_view', '/${'a'.repeat(600)}')`),
        ),
      '23514',
    );
  });

  it('les index de lecture/purge du cadrage existent toujours', async () => {
    const rows = await harness.raw(
      sql`select indexname from pg_indexes
          where schemaname = ${schema} and tablename = 'kreiz_analytics_events'`,
    );
    const names = rows.map((row) => row.indexname as string);
    expect(names).toContain('kreiz_analytics_events_name_created_at_idx');
    expect(names).toContain('kreiz_analytics_events_created_at_idx');
    expect(names).toContain('kreiz_analytics_events_dedup_key_unique');
  });
});
