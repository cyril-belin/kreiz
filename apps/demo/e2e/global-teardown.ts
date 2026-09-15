import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { closeTestDb, query } from './db';
import { stopHookServer } from './rebuild-hook-server';
import { stopStorageServer } from './storage-server';

/**
 * Nettoyage E2E — ordre imposé par les FK :
 * 1. audit média (créé au slice 5 ; événements système à acteur NULL qui ne
 *    partent pas avec les admins) ;
 * 2. redirections (créées au slice 4 par les publications ; `content_entry_id`
 *    part en SET NULL si on attend la suppression des contenus) ;
 * 3. audit (RESTRICT acteur) : par acteur **ou par entité ciblée** (actions
 *    opérateur, actor NULL ; événements contenu, entity_id = entrée ;
 *    événements site, entity_id = 'rebuild') ;
 * 4. contenus (RESTRICT created_by) créés via l'UI ;
 * 5. **médias** — APRÈS les contenus : la couverture (courante ou snapshot)
 *    pose un RESTRICT de `kreiz_content_entries` vers `kreiz_media` ;
 * 6. admins (sessions en CASCADE), puis compteurs de rate limit éphémères.
 *
 * Chaque étape rejoue les erreurs **réseau transitoires** Neon (constaté en
 * réel : un échec transitoire ici abandonnait tout le nettoyage et laissait
 * des lignes résiduelles aux runs suivants). Aucune donnée résiduelle
 * (mission slice 2 §26/§28, slice 3 §34, slice 4 §49, slice 5 §49).
 */

/** Rejoue une requête de nettoyage sur erreur réseau transitoire (Neon). */
async function queryWithRetry(text: string, values: unknown[] = [], attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await query(text, values);
      return;
    } catch (error) {
      lastError = error;
      const message = String((error as { message?: unknown }).message ?? '');
      const transient = /fetch failed|ECONNRESET|other side closed|Connect Timeout|terminating/i.test(message);
      if (attempt === attempts || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

const CLEANUP: Array<[string, unknown[]]> = [
  [
    `delete from kreiz_admin_audit_log
     where entity_type = 'media'
        or entity_id in (select id::text from kreiz_media where uploaded_by in (select id from kreiz_admin_users where email like 'e2e-%'))`,
    [],
  ],
  [
    `delete from kreiz_redirects
     where content_entry_id in (select id from kreiz_content_entries
           where created_by in (select id from kreiz_admin_users where email like 'e2e-%'))
        or from_path like '/articles/e2e-%'`,
    [],
  ],
  [
    `delete from kreiz_admin_audit_log
     where actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%')
        or entity_id in (select id::text from kreiz_admin_users where email like 'e2e-%')
        or entity_id in (select id::text from kreiz_content_entries where created_by in (select id from kreiz_admin_users where email like 'e2e-%'))
        or (entity_type = 'site' and actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%'))`,
    [],
  ],
  [
    `delete from kreiz_content_entries
     where created_by in (select id from kreiz_admin_users where email like 'e2e-%')`,
    [],
  ],
  [`delete from kreiz_media where uploaded_by in (select id from kreiz_admin_users where email like 'e2e-%')`, []],
  ["delete from kreiz_admin_users where email like 'e2e-%'", []],
  ['delete from kreiz_rate_limits', []],
];

export default async function globalTeardown(): Promise<void> {
  try {
    for (const [text, values] of CLEANUP) {
      await queryWithRetry(text, values);
    }
  } finally {
    rmSync(join(import.meta.dirname, '.media-state.json'), { force: true });
    stopStorageServer();
    await stopHookServer();
    await closeTestDb();
  }
}
