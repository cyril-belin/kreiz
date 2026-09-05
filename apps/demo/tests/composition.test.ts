import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_TABLE_NAMES = [
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

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const schemaSource = readFileSync(`${projectRoot}src/schema.ts`, 'utf8');
const drizzleDir = `${projectRoot}drizzle`;
const journalPath = `${drizzleDir}/meta/_journal.json`;

describe('composition du schéma — Core + Project', () => {
  it('compose via l’API publique @kreiz/core/data — aucun import profond', () => {
    expect(schemaSource).toMatch(/from '@kreiz\/core\/data'/);
    expect(schemaSource).not.toMatch(/@kreiz\/core\/(src|dist)/);
    expect(schemaSource).not.toMatch(/\.\.\/\.\.\/packages/);
  });

  it('expose les neuf tables Core et une table Project demo_settings', () => {
    for (const name of [
      'adminUsers',
      'adminSessions',
      'adminAuditLog',
      'contentEntries',
      'redirects',
      'media',
      'contactRequests',
      'analyticsEvents',
      'rateLimits',
    ]) {
      expect(schemaSource).toContain(name);
    }
    expect(schemaSource).toContain("pgTable('demo_settings'");
  });
});

describe('chaîne de migrations possédée par apps/demo', () => {
  const sqlFiles = existsSync(drizzleDir)
    ? readdirSync(drizzleDir).filter((name) => name.endsWith('.sql')).sort()
    : [];

  it('existe dans apps/demo (jamais dans le Core)', () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('la première migration contient les dix tables du schéma composé', () => {
    const sql = readFileSync(`${drizzleDir}/${sqlFiles[0]}`, 'utf8');
    for (const table of CORE_TABLE_NAMES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('CREATE TABLE "demo_settings"');
  });

  it('la première migration contient les contraintes structurantes', () => {
    const sql = readFileSync(`${drizzleDir}/${sqlFiles[0]}`, 'utf8');
    // Unicité partielle (route_namespace, slug) sur contenus actifs.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "kreiz_content_entries_namespace_slug_active_key"[\s\S]*WHERE "kreiz_content_entries"\."deleted_at" is null/,
    );
    // Unicité email admin et from_path des redirections.
    expect(sql).toContain('CREATE UNIQUE INDEX "kreiz_admin_users_email_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "kreiz_redirects_from_path_key"');
    // Foreign keys du cadrage, avec ON DELETE explicites.
    expect(sql).toContain('ON DELETE restrict');
    expect(sql).toContain('ON DELETE cascade');
    expect(sql).toContain('ON DELETE set null');
    expect(sql.match(/FOREIGN KEY/g)?.length).toBeGreaterThanOrEqual(8);
    // Contraintes d'état matérialisées.
    expect(sql).toContain('kreiz_contact_requests_status_check');
    expect(sql).toContain('kreiz_analytics_events_event_name_check');
  });
});
