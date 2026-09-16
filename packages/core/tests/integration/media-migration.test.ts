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

/**
 * Test de migration **slice 5** (mission §47/§49) : la chaîne complète de
 * `apps/demo` est rejouée dans un schéma isolé de la base réelle (tous les
 * fichiers SQL présents, 0005 inclus — la garde `LAST` ci-dessous reste
 * l'affaire de la migration la plus récente du moment) et la sémantique du
 * snapshot de couverture est vérifiée : `published_cover_media_id` absent
 * avant `0003`, présent, nullable et FK RESTRICT après.
 *
 * Le Core ne possède toujours aucune migration : les fichiers SQL lus ici
 * appartiennent à `apps/demo/drizzle`.
 */
const runId = crypto.randomUUID().slice(0, 8);
const schema = `kreiz_media_mig_${runId}`;
const drizzleDir = fileURLToPath(new URL('../../../../apps/demo/drizzle', import.meta.url));

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const LAST = migrationFiles.at(-1);
if (LAST && !LAST.startsWith('0005')) {
  throw new Error(
    `@kreiz/core : la dernière migration attendue pour ce test est 0005 — trouvé « ${LAST} ». Mettre à jour media-migration.test.ts.`,
  );
}

function qualify(statement: string): string {
  // `ON "table"` couvre les clauses ON des index (non qualifiées dans le SQL
  // drizzle) sans toucher `ON DELETE` ; REFERENCES/CREATE/ALTER portent leur
  // qualification. (Même mécanique que publication-migration.test.ts.)
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

async function columnMeta(
  harness: IntegrationHarness,
  column: string,
): Promise<{ nullable: boolean } | null> {
  const rows = await harness.raw(
    sql`select is_nullable from information_schema.columns
        where table_schema = ${schema} and table_name = 'kreiz_content_entries' and column_name = ${column}`,
  );
  const row = rows.at(0);
  return row ? { nullable: row.is_nullable === 'YES' } : null;
}

describeIntegration('migration médias — chaîne 0000 → 0003 (base réelle)', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`create schema if not exists "${schema}"`)),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`drop schema if exists "${schema}" cascade`)),
    );
    await harness.close();
  });

  it('la chaîne rejouée expose published_cover_media_id nullable avec FK RESTRICT', async () => {
    for (const file of migrationFiles) {
      await applyMigrationFile(harness, file);
      if (file.startsWith('0000') || file.startsWith('0001') || file.startsWith('0002')) {
        // Avant le slice 5 : le snapshot de couverture n'existe pas.
        expect(await columnMeta(harness, 'published_cover_media_id')).toBeNull();
      }
      if (file.startsWith('0003')) {
        const column = await columnMeta(harness, 'published_cover_media_id');
        expect(column).toEqual({ nullable: true });
      }
    }

    // FK RESTRICT réelle : une couverture publiée empêche la suppression du média.
    const adminId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    await harness.raw(sql.raw(`insert into "${schema}".kreiz_admin_users (id, email, password_hash, name) values ('${adminId}', 'mig-${runId}@example.test', 'x', 'Migration')`));
    await harness.raw(sql.raw(`insert into "${schema}".kreiz_media (id, status, storage_key, mime, size_bytes, uploaded_by) values ('${mediaId}', 'ready', 'media/${mediaId}/original', 'image/png', 1, '${adminId}')`));
    await harness.raw(sql.raw(`insert into "${schema}".kreiz_content_entries (id, content_type, route_namespace, title, slug, status, cover_media_id, published_cover_media_id, data, created_by, updated_by) values ('${crypto.randomUUID()}', 'article', 'articles', 'Migration', 'migration-${runId}', 'published', '${mediaId}', '${mediaId}', '{}', '${adminId}', '${adminId}')`));

    // Préconditions : la ligne de contenu référence bien le média et la FK
    // RESTRICT existe sur le snapshot (le DELETE doit être bloqué).
    const contentCount = await harness.raw(
      sql`select count(*)::int as count from ${sql.raw(`"${schema}".kreiz_content_entries`)} where published_cover_media_id = ${mediaId}`,
    );
    expect(contentCount.at(0)?.count).toBe(1);
    const fkCount = await harness.raw(
      sql`select count(*)::int as count from pg_constraint
          where conrelid = ${`${schema}.kreiz_content_entries`}::regclass
            and confrelid = ${`${schema}.kreiz_media`}::regclass and contype = 'f'`,
    );
    expect(Number(fkCount.at(0)?.count ?? 0)).toBeGreaterThanOrEqual(2); // cover + snapshot

    let restrictCode: string | null = null;
    try {
      await harness.raw(sql.raw(`delete from "${schema}".kreiz_media where id = '${mediaId}'`));
    } catch (error) {
      // L'erreur brute est wrappée par Drizzle : le code SQLSTATE est sur la cause.
      restrictCode = pgErrorCode(error);
    }
    expect(restrictCode).toBe('23001');
  });
});
