import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Test de migration **depuis le schéma du slice 1** (revue slice 2) :
 * la chaîne de migrations de `apps/demo` est rejouée dans un **schéma
 * isolé** de la base réelle — d'abord `0000` (état slice 1 :
 * `actor_admin_id NOT NULL`), puis `0001` (slice 2 : colonne nullable) —
 * et la sémantique FK/audit est vérifiée sur chaque état.
 *
 * Le Core ne possède toujours aucune migration : les fichiers SQL lus ici
 * appartiennent à `apps/demo/drizzle`.
 */
const runId = crypto.randomUUID().slice(0, 8);
const schema = `kreiz_mig_${runId}`;
const drizzleDir = fileURLToPath(new URL('../../../../apps/demo/drizzle', import.meta.url));

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

/**
 * Qualifie les **références de tables** du SQL de migration par le schéma
 * isolé. Formes réelles des fichiers drizzle : `CREATE TABLE "t"`,
 * `ALTER TABLE "t"`, `CREATE [UNIQUE] INDEX "i" ON "t"` (sans schéma) et
 * `REFERENCES "public"."t"` (déjà qualifié). Les noms d'index et de
 * contraintes ne sont PAS touchés : PostgreSQL refuse de les qualifier
 * (ils vivent dans le schéma de leur table).
 */
function qualify(statement: string): string {
  return statement
    .replace(/(CREATE TABLE |ALTER TABLE |ON )"([^"]+)"/g, `$1"${schema}"."$2"`)
    .replace(/REFERENCES "public"\./g, `REFERENCES "${schema}".`);
}

async function applyMigrationFile(
  harness: IntegrationHarness,
  fileName: string,
): Promise<void> {
  const content = readFileSync(`${drizzleDir}/${fileName}`, 'utf8');
  for (const statement of content.split('--> statement-breakpoint')) {
    if (!statement.trim()) continue;
    await withTransientNetworkRetry(() => harness.raw(sql.raw(qualify(statement))));
  }
}

async function columnIsNullability(harness: IntegrationHarness): Promise<string> {
  const rows = await harness.raw(
    sql`select is_nullable from information_schema.columns where table_schema = ${schema} and table_name = 'kreiz_admin_audit_log' and column_name = 'actor_admin_id'`,
  );
  return String(rows[0]?.is_nullable);
}

describeIntegration('migration audit — schéma slice 1 → slice 2 (base réelle)', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
    // La migration slice 2 (0001) doit exister dans apps/demo/drizzle.
    expect(migrationFiles.length).toBeGreaterThanOrEqual(2);
    await withTransientNetworkRetry(() =>
      harness.raw(sql`create schema ${sql.identifier(schema)}`),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await withTransientNetworkRetry(() =>
      harness.raw(sql`drop schema if exists ${sql.identifier(schema)} cascade`),
    );
    await harness.close();
  }, 60_000);

  it('l’état slice 1 (0000 seul) impose actor_admin_id NOT NULL', async () => {
    await applyMigrationFile(harness, migrationFiles[0]!);
    expect(await columnIsNullability(harness)).toBe('NO');
  });

  it('la migration slice 2 (0001) rend actor_admin_id nullable — sans perte de contrainte', async () => {
    await applyMigrationFile(harness, migrationFiles[1]!);
    expect(await columnIsNullability(harness)).toBe('YES');

    // FK conservée : référence inconnue toujours refusée (23503)…
    const adminRows = await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_admin_users" (email, password_hash, name) values (${`mig-${runId}@example.test`}, 'hash-test', 'Mig') returning id`,
      ),
    );
    const adminId = String(adminRows[0]?.id);
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into ${sql.identifier(schema)}."kreiz_admin_audit_log" (actor_admin_id, action, entity_type, entity_id) values (${crypto.randomUUID()}, 'test.action', 'test', 'x')`,
        ),
      '23503',
    );

    // … et RESTRICT conservé : un admin référencé par un acteur réel ne
    // peut pas être supprimé (23001).
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_admin_audit_log" (actor_admin_id, action, entity_type, entity_id) values (${adminId}, 'admin.login', 'admin_user', ${adminId})`,
      ),
    );
    await expectPgError(
      () =>
        harness.raw(
          sql`delete from ${sql.identifier(schema)}."kreiz_admin_users" where id = ${adminId}`,
        ),
      '23001',
    );
  });

  it('une action opérateur (acteur NULL) est enregistrable et ne bloque pas la suppression de l’admin cible', async () => {
    // L'admin précédent est bloqué par sa ligne d'audit à acteur réel.
    // Ici : un admin ciblé uniquement par une action opérateur (acteur
    // NULL, entity_id = cible) — la suppression reste possible, preuve que
    // NULL ne « ping » personne.
    const orphanRows = await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_admin_users" (email, password_hash, name) values (${`mig-null-${runId}@example.test`}, 'hash-test', 'Mig Null') returning id`,
      ),
    );
    const orphanId = String(orphanRows[0]?.id);
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_admin_audit_log" (actor_admin_id, action, entity_type, entity_id, metadata) values (null, 'admin.password_reset', 'admin_user', ${orphanId}, ${JSON.stringify({ source: 'cli', revokedSessions: 0 })}::jsonb)`,
      ),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`delete from ${sql.identifier(schema)}."kreiz_admin_users" where id = ${orphanId}`,
      ),
    );
    // La ligne d'audit opérateur survit à la suppression (append-only).
    const auditRows = await harness.raw(
      sql`select count(*)::int as n from ${sql.identifier(schema)}."kreiz_admin_audit_log" where action = 'admin.password_reset' and entity_id = ${orphanId}`,
    );
    expect(auditRows[0]?.n).toBe(1);
  });
});
