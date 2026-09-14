import { closeTestDb, query } from './db';

/**
 * Nettoyage E2E — ordre imposé par les FK :
 * 1. audit (RESTRICT acteur) : par acteur **ou par entité ciblée** (actions
 *    opérateur, actor NULL ; événements contenu, entity_id = entrée) ;
 * 2. contenus (RESTRICT created_by) créés via l'UI au slice 3 ;
 * 3. admins (sessions en CASCADE), puis compteurs de rate limit éphémères.
 * Aucune donnée résiduelle (mission slice 2 §26/§28, slice 3 §34).
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await query(
      `delete from kreiz_admin_audit_log
       where actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%')
          or entity_id in (select id::text from kreiz_admin_users where email like 'e2e-%')
          or entity_id in (select id::text from kreiz_content_entries where created_by in (select id from kreiz_admin_users where email like 'e2e-%'))`,
    );
    await query(
      `delete from kreiz_content_entries
       where created_by in (select id from kreiz_admin_users where email like 'e2e-%')`,
    );
    await query("delete from kreiz_admin_users where email like 'e2e-%'");
    await query('delete from kreiz_rate_limits');
  } finally {
    await closeTestDb();
  }
}
