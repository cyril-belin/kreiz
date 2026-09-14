import { closeTestDb, query } from './db';
import { stopHookServer } from './rebuild-hook-server';

/**
 * Nettoyage E2E — ordre imposé par les FK :
 * 1. redirections (créées au slice 4 par les publications ; `content_entry_id`
 *    part en SET NULL si on attend la suppression des contenus) ;
 * 2. audit (RESTRICT acteur) : par acteur **ou par entité ciblée** (actions
 *    opérateur, actor NULL ; événements contenu, entity_id = entrée ;
 *    événements site, entity_id = 'rebuild') ;
 * 3. contenus (RESTRICT created_by) créés via l'UI ;
 * 4. admins (sessions en CASCADE), puis compteurs de rate limit éphémères.
 * Aucune donnée résiduelle (mission slice 2 §26/§28, slice 3 §34, slice 4 §49).
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await query(
      `delete from kreiz_redirects
       where content_entry_id in (select id from kreiz_content_entries
             where created_by in (select id from kreiz_admin_users where email like 'e2e-%'))
          or from_path like '/articles/e2e-%'`,
    );
    await query(
      `delete from kreiz_admin_audit_log
       where actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%')
          or entity_id in (select id::text from kreiz_admin_users where email like 'e2e-%')
          or entity_id in (select id::text from kreiz_content_entries where created_by in (select id from kreiz_admin_users where email like 'e2e-%'))
          or (entity_type = 'site' and actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%'))`,
    );
    await query(
      `delete from kreiz_content_entries
       where created_by in (select id from kreiz_admin_users where email like 'e2e-%')`,
    );
    await query("delete from kreiz_admin_users where email like 'e2e-%'");
    await query('delete from kreiz_rate_limits');
  } finally {
    await stopHookServer();
    await closeTestDb();
  }
}
