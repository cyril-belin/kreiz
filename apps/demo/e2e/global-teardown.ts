import { closeTestDb, query } from './db';

/**
 * Nettoyage E2E : ordre imposé par les FK — audit (RESTRICT) d'abord, puis
 * admins (sessions en CASCADE), puis compteurs de rate limit éphémères.
 * L'audit est supprimé par acteur OU par entité ciblée (les actions
 * opérateur, actor_admin_id NULL, référencent l'admin via entity_id).
 * Aucune donnée résiduelle (mission slice 2 §26/§28).
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await query(
      `delete from kreiz_admin_audit_log
       where actor_admin_id in (select id from kreiz_admin_users where email like 'e2e-%')
          or entity_id in (select id::text from kreiz_admin_users where email like 'e2e-%')`,
    );
    await query("delete from kreiz_admin_users where email like 'e2e-%'");
    await query('delete from kreiz_rate_limits');
  } finally {
    await closeTestDb();
  }
}
