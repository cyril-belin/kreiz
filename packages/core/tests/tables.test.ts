import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { defineCoreTables } from '../src/data/define-core-tables';

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

describe('defineCoreTables', () => {
  it('expose exactement les neuf tables du Core', () => {
    const tables = defineCoreTables();
    expect(Object.keys(tables).sort()).toEqual(
      [
        'adminAuditLog',
        'adminSessions',
        'adminUsers',
        'analyticsEvents',
        'contactRequests',
        'contentEntries',
        'media',
        'rateLimits',
        'redirects',
      ].sort(),
    );
  });

  it('nomme chaque table avec le préfixe kreiz_ figé en V1', () => {
    const tables = defineCoreTables();
    const names = Object.values(tables).map((table) => getTableName(table));
    expect(names.sort()).toEqual([...CORE_TABLE_NAMES].sort());
    for (const name of names) {
      expect(name.startsWith('kreiz_')).toBe(true);
    }
  });

  it('retourne les mêmes instances à chaque appel — pas de duplication incohérente', () => {
    const first = defineCoreTables();
    const second = defineCoreTables();
    expect(second).toBe(first);
    for (const key of Object.keys(first)) {
      expect(second[key as keyof typeof first]).toBe(first[key as keyof typeof first]);
    }
  });

  it('gèle l’agrégat — l’application compose par extension, pas par mutation', () => {
    expect(Object.isFrozen(defineCoreTables())).toBe(true);
  });

  it('positionne les contraintes structurantes du cadrage', () => {
    const { contentEntries, redirects, adminUsers } = defineCoreTables();

    const contentConfig = getTableConfig(contentEntries);
    const contentIndexes = contentConfig.indexes.map((index) => index.config.name);
    expect(contentIndexes).toContain('kreiz_content_entries_namespace_slug_active_key');
    expect(contentIndexes).toContain('kreiz_content_entries_type_status_published_idx');
    expect(contentIndexes).toContain('kreiz_content_entries_namespace_published_idx');

    const partialUnique = contentConfig.indexes.find(
      (index) => index.config.name === 'kreiz_content_entries_namespace_slug_active_key',
    );
    expect(partialUnique?.config.unique).toBe(true);
    expect(partialUnique?.config.where).toBeDefined();

    expect(getTableConfig(redirects).indexes.map((index) => index.config.name)).toContain(
      'kreiz_redirects_from_path_key',
    );
    expect(getTableConfig(adminUsers).indexes.map((index) => index.config.name)).toContain(
      'kreiz_admin_users_email_key',
    );
  });
});
