import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeIntegration,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Test de migration **depuis le schéma du slice 1** (mission §51) : la
 * chaîne de migrations de `apps/demo` est rejouée dans un **schéma isolé**
 * de la base réelle — `0000` (état slice 1 : pas d'état public figé),
 * `0001` (slice 2), puis `0002` (slice 4 : colonnes snapshot `published_*`
 * nullable) — et la sémantique de publication est vérifiée sur chaque état.
 *
 * Le Core ne possède toujours aucune migration : les fichiers SQL lus ici
 * appartiennent à `apps/demo/drizzle`.
 */
const runId = crypto.randomUUID().slice(0, 8);
const schema = `kreiz_pub_mig_${runId}`;
const drizzleDir = fileURLToPath(new URL('../../../../apps/demo/drizzle', import.meta.url));

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

/**
 * Qualifie les **références de tables** du SQL de migration par le schéma
 * isolé (même mécanique que `audit-migration.test.ts`).
 */
function qualify(statement: string): string {
  return statement
    .replace(/(CREATE TABLE |ALTER TABLE |ON )"([^"]+)"/g, `$1"${schema}"."$2"`)
    .replace(/REFERENCES "public"\./g, `REFERENCES "${schema}".`);
}

async function applyMigrationFile(harness: IntegrationHarness, fileName: string): Promise<void> {
  const content = readFileSync(`${drizzleDir}/${fileName}`, 'utf8');
  for (const statement of content.split('--> statement-breakpoint')) {
    if (!statement.trim()) continue;
    await withTransientNetworkRetry(() => harness.raw(sql.raw(qualify(statement))));
  }
}

async function columnExists(harness: IntegrationHarness, column: string): Promise<boolean> {
  const rows = await harness.raw(
    sql`select 1 from information_schema.columns where table_schema = ${schema} and table_name = 'kreiz_content_entries' and column_name = ${column}`,
  );
  return rows.length > 0;
}

describeIntegration('migration publication — schéma slice 1 → slice 4 (base réelle)', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
    // La migration slice 4 (0002) doit exister dans apps/demo/drizzle.
    expect(migrationFiles.length).toBeGreaterThanOrEqual(3);
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

  it('l’état slice 1 (0000) ne connaît aucun snapshot public', async () => {
    await applyMigrationFile(harness, migrationFiles[0]!);
    expect(await columnExists(harness, 'published_at')).toBe(true);
    expect(await columnExists(harness, 'published_slug')).toBe(false);
    expect(await columnExists(harness, 'published_data')).toBe(false);
  });

  it('la migration slice 4 (0002) ajoute les snapshots publiés, tous nullables — l’existant n’est pas dégradé', async () => {
    await applyMigrationFile(harness, migrationFiles[1]!); // 0001 (slice 2)
    await applyMigrationFile(harness, migrationFiles[2]!); // 0002 (slice 4)

    for (const column of ['published_slug', 'published_title', 'published_data', 'published_seo']) {
      const rows = await harness.raw(
        sql`select is_nullable from information_schema.columns where table_schema = ${schema} and table_name = 'kreiz_content_entries' and column_name = ${column}`,
      );
      expect(rows, `colonne ${column} attendue`).toHaveLength(1);
      expect(String(rows[0]!.is_nullable)).toBe('YES');
    }

    // Les lignes préexistantes (publiées avant la migration) restent
    // lisibles : snapshots NULL = état « jamais publié » assumé, la colonne
    // n'a jamais été NOT NULL.
    const admin = await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_admin_users" (email, password_hash, name) values (${`pubmig-${runId}@example.test`}, 'hash-test', 'Mig') returning id`,
      ),
    );
    const adminId = String(admin[0]!.id);
    const inserted = await withTransientNetworkRetry(() =>
      harness.raw(
        sql`insert into ${sql.identifier(schema)}."kreiz_content_entries" (content_type, route_namespace, title, slug, status, published_at, data, created_by, updated_by)
            values ('article', 'articles', 'Pré-migration', 'pre-migration', 'published', now(), '{}'::jsonb, ${adminId}, ${adminId})
            returning published_slug, published_title`,
      ),
    );
    expect(inserted[0]).toMatchObject({ published_slug: null, published_title: null });
  });
});
