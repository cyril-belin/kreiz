import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration, pgErrorCode, setupIntegration, withTransientNetworkRetry, type IntegrationHarness } from './helpers';

/**
 * Test de migration **slice 7** : la chaîne complète de `apps/demo` est
 * rejouée depuis l'historique intégral (`0000 → 0004`) dans un schéma isolé
 * de la base réelle, puis la sémantique de `kreiz_contact_requests` est
 * vérifiée sur l'état final :
 * - colonnes de notification (`notification_status` avec défaut
 *   `not_configured` — héritage honnête des lignes pré-slice 7 —,
 *   `notification_attempts`, `notification_failure`, `notified_at`,
 *   `notification_next_attempt_at`) et `dedup_key` nullable ;
 * - CHECK sur les états de notification ;
 * - index unique **partiel** de déduplication (`dedup_key is not null`) :
 *   deux POST concurrents de même clé → une seule ligne (23505 pour un
 *   doublon direct) ;
 * - l'insertion **sans** `dedup_key` reste permise (lignes héritées).
 *
 * Le Core ne possède toujours aucune migration : les fichiers SQL lus ici
 * appartiennent à `apps/demo/drizzle`.
 */
const runId = crypto.randomUUID().slice(0, 8);
const schema = `kreiz_contact_mig_${runId}`;
const drizzleDir = fileURLToPath(new URL('../../../../apps/demo/drizzle', import.meta.url));

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

function qualify(statement: string): string {
  return statement
    .replace(/(CREATE TABLE |ALTER TABLE |ON )"([^"]+)"/g, `$1"${schema}"."$2"`)
    .replace(/REFERENCES "public"\./g, `REFERENCES "${schema}".`);
}

let harness: IntegrationHarness;

beforeAll(async () => {
  harness = await setupIntegration();
  await withTransientNetworkRetry(() =>
    harness.raw(sql`create schema if not exists ${sql.raw(schema)}`),
  );
  for (const fileName of migrationFiles) {
    const content = readFileSync(`${drizzleDir}/${fileName}`, 'utf8');
    for (const statement of content.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue;
      await withTransientNetworkRetry(() => harness.raw(sql.raw(qualify(statement))));
    }
  }
});

afterAll(async () => {
  if (!harness) return;
  await withTransientNetworkRetry(() =>
    harness.raw(sql`drop schema if exists ${sql.raw(schema)} cascade`),
  );
  await harness.close();
});

function table(name: string): string {
  return `${schema}.${name}`;
}

describeIntegration('migration 0004 — kreiz_contact_requests (historique complet rejoué)', () => {
  it('les colonnes slice 7 existent avec leurs défauts', async () => {
    const rows = await harness.raw(
      sql`select column_name, is_nullable, column_default
          from information_schema.columns
          where table_schema = ${schema} and table_name = 'kreiz_contact_requests'
          order by column_name`,
    );
    const byName = new Map(rows.map((row) => [row.column_name as string, row]));
    for (const expected of [
      'dedup_key',
      'notification_status',
      'notification_attempts',
      'notification_failure',
      'notified_at',
      'notification_next_attempt_at',
    ]) {
      expect(byName.has(expected), expected).toBe(true);
    }
    expect(byName.get('notification_status')?.is_nullable).toBe('NO');
    expect(String(byName.get('notification_status')?.column_default)).toContain('not_configured');
    expect(byName.get('dedup_key')?.is_nullable).toBe('YES');
    expect(byName.get('notification_attempts')?.is_nullable).toBe('NO');
  });

  it('l’état par défaut d’une ligne héritée est not_configured (jamais retentée à l’aveugle)', async () => {
    await harness.raw(
      sql.raw(
        `insert into ${table('kreiz_contact_requests')} (form_id, payload) values ('contact', '{"message":"ancien"}'::jsonb)`,
      ),
    );
    const rows = await harness.raw(
      sql.raw(`select notification_status, notification_attempts from ${table('kreiz_contact_requests')} where form_id = 'contact'`),
    );
    expect(rows.at(0)?.notification_status).toBe('not_configured');
    expect(Number(rows.at(0)?.notification_attempts)).toBe(0);
  });

  it('le CHECK notification_status refuse un état inconnu', async () => {
    await expectPgErrorLocal(
      () =>
        harness.raw(
          sql.raw(
            `insert into ${table('kreiz_contact_requests')} (form_id, payload, notification_status) values ('contact', '{}'::jsonb, 'perdu')`,
          ),
        ),
      '23514',
    );
  });

  it('l’index unique partiel de déduplication arbitre les doubles soumissions', async () => {
    await harness.raw(
      sql.raw(
        `insert into ${table('kreiz_contact_requests')} (form_id, payload, dedup_key) values ('contact', '{"n":1}'::jsonb, 'dup-${runId}')`,
      ),
    );
    // Second insert avec la même clé : conflit unique (23505) — le
    // repository passe par ON CONFLICT DO NOTHING puis relit la ligne.
    await expectPgErrorLocal(
      () =>
        harness.raw(
          sql.raw(
            `insert into ${table('kreiz_contact_requests')} (form_id, payload, dedup_key) values ('contact', '{"n":2}'::jsonb, 'dup-${runId}')`,
          ),
        ),
      '23505',
    );
    // Clé NULL (lignes héritées) : toujours permise, sans conflit.
    await harness.raw(
      sql.raw(
        `insert into ${table('kreiz_contact_requests')} (form_id, payload) values ('contact', '{"n":3}'::jsonb)`,
      ),
    );
    const rows = await harness.raw(
      sql.raw(`select count(*)::int as total from ${table('kreiz_contact_requests')}`),
    );
    expect(Number(rows.at(0)?.total)).toBe(3);
  });

  it('l’index de file d’attente du balayage existe (partiel pending/failed)', async () => {
    const rows = await harness.raw(
      sql`select indexname from pg_indexes
          where schemaname = ${schema} and tablename = 'kreiz_contact_requests'`,
    );
    const names = rows.map((row) => row.indexname as string);
    expect(names).toContain('kreiz_contact_requests_notification_due_idx');
    expect(names).toContain('kreiz_contact_requests_dedup_key_unique');
  });
});

async function expectPgErrorLocal(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = pgErrorCode(error);
    if (actual !== code) {
      throw new Error(`Code PostgreSQL attendu ${code}, reçu ${actual ?? 'aucun'} (${String(error)})`);
    }
    return;
  }
  throw new Error(`Erreur PostgreSQL ${code} attendue — aucune levée`);
}
