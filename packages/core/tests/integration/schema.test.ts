import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeIntegration,
  setupIntegration,
  type IntegrationHarness,
} from './helpers';

/**
 * Structure du schéma, vérifiée contre PostgreSQL réel après application de
 * la migration de l'application consommatrice. La base testée est celle de
 * l'application (branche Neon en CI, base jetable en local) : y vérifier
 * `demo_settings` prouve que la composition Core + Project est bien arrivée
 * jusqu'en base.
 */

const CORE_TABLES = [
  'kreiz_admin_users',
  'kreiz_admin_sessions',
  'kreiz_admin_audit_log',
  'kreiz_content_entries',
  'kreiz_redirects',
  'kreiz_media',
  'kreiz_contact_requests',
  'kreiz_analytics_events',
  'kreiz_rate_limits',
];

/**
 * Règles ON DELETE attendues par **table** — les noms de contraintes sont
 * tronqués à 63 caractères par PostgreSQL, on matche donc sur la table et
 * la règle, pas sur le nom complet.
 * attendu : c = cascade, r = restrict, n = set null (pg_constraint.confdeltype)
 */
const FK_DELETE_RULES: Array<[string, string, number]> = [
  // [table, règle ON DELETE, nombre de FK concernées]
  ['kreiz_admin_sessions', 'c', 1],
  ['kreiz_admin_audit_log', 'r', 1],
  ['kreiz_media', 'r', 1],
  ['kreiz_redirects', 'n', 1],
  ['kreiz_analytics_events', 'n', 1],
  ['kreiz_content_entries', 'r', 3], // created_by, updated_by, cover_media_id
];

const UNIQUE_INDEXES = [
  'kreiz_admin_users_email_key',
  'kreiz_admin_sessions_token_hash_key',
  'kreiz_redirects_from_path_key',
  'kreiz_content_entries_namespace_slug_active_key',
];

const PLAIN_INDEXES = [
  'kreiz_admin_sessions_admin_id_idx',
  'kreiz_content_entries_type_status_published_idx',
  'kreiz_content_entries_namespace_published_idx',
  'kreiz_analytics_events_name_created_at_idx',
  'kreiz_analytics_events_created_at_idx',
];

describeIntegration('schéma — base migrée par la chaîne apps/demo', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await harness.close();
  });

  it('contient les neuf tables kreiz_* et la table projet demo_settings', async () => {
    const rows = await harness.raw(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((row) => row.table_name);
    for (const table of [...CORE_TABLES, 'demo_settings']) {
      expect(names, `table manquante : ${table}`).toContain(table);
    }
  });

  it('porte les colonnes essentielles — y compris les nullables attendus', async () => {
    const rows = await harness.raw(
      sql`select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
    );
    const nullable = new Set(
      rows.filter((row) => row.is_nullable === 'YES').map((row) => `${row.table_name}.${row.column_name}`),
    );

    const expected = (table: string, columns: string[]) =>
      columns.forEach((column) => expect(nullable, `${table}.${column} devrait être nullable`).toContain(`${table}.${column}`));

    expected('kreiz_admin_users', ['disabled_at']);
    expected('kreiz_admin_sessions', ['revoked_at']);
    expected('kreiz_content_entries', ['cover_media_id', 'published_at', 'deleted_at']);
    expected('kreiz_media', ['failure_reason', 'width', 'height', 'deleted_at']);
    expected('kreiz_analytics_events', ['referrer', 'content_type', 'content_entry_id', 'device_class', 'country']);
    expected('kreiz_redirects', ['content_entry_id']);
  });

  it('applique les règles ON DELETE du domaine sur les foreign keys', async () => {
    const rows = await harness.raw(
      sql`select conrelid::regclass::text as table_name, confdeltype from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`,
    );
    // Comptage par (table, règle).
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.table_name}:${row.confdeltype}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [table, rule, expectedCount] of FK_DELETE_RULES) {
      expect(
        counts.get(`${table}:${rule}`),
        `${table} : ${expectedCount} FK ON DELETE ${rule} attendues`,
      ).toBe(expectedCount);
    }
  });

  it('possède les index validés par le cadrage — dont l’unicité partielle des contenus actifs', async () => {
    const rows = await harness.raw(
      sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const definitions = new Map(
      rows.map((row) => [row.indexname as string, row.indexdef as string]),
    );

    for (const index of [...UNIQUE_INDEXES, ...PLAIN_INDEXES]) {
      expect(definitions.has(index), `index manquant : ${index}`).toBe(true);
    }
    for (const index of UNIQUE_INDEXES) {
      expect(definitions.get(index)).toMatch(/UNIQUE/);
    }
    // Unicité (route_namespace, slug) limitée aux contenus non supprimés.
    expect(definitions.get('kreiz_content_entries_namespace_slug_active_key')).toMatch(
      /WHERE.*deleted_at.*is null/i,
    );
    // Tri par date décroissant des listings (cadrage §7).
    expect(definitions.get('kreiz_content_entries_type_status_published_idx')).toMatch(
      /content_type.*status.*published_at.*DESC/i,
    );
    expect(definitions.get('kreiz_analytics_events_name_created_at_idx')).toMatch(
      /event_name.*created_at/i,
    );
  });
});
