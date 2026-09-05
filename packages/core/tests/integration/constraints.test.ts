import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  type IntegrationHarness,
} from './helpers';

/**
 * Comportements SQL importants, testés contre PostgreSQL réel via l'API
 * Drizzle (db.execute) — pas via les repositories : ce sont des comportements
 * de la base, pas du domaine. Chaque run utilise un préfixe unique
 * (`it-<runId>`) et nettoie toutes ses lignes en fin de fichier (aucune
 * donnée fictive persistante), dans un ordre compatible avec les FK.
 */
const runId = crypto.randomUUID().slice(0, 8);
const emailPattern = `it-${runId}%@example.test`;

let harness: IntegrationHarness;
let userId: string;

async function insertUser(email: string): Promise<string> {
  const rows = await harness.raw(
    sql`insert into kreiz_admin_users (email, password_hash, name) values (${email}, 'hash-test', 'Utilisateur test') returning id`,
  );
  return rows[0]?.id as string;
}

async function insertContent(namespace: string, slug: string, creatorId: string): Promise<string> {
  const rows = await harness.raw(
    sql`insert into kreiz_content_entries (content_type, route_namespace, title, slug, status, created_by, updated_by)
        values ('article', ${namespace}, 'Titre test', ${slug}, 'draft', ${creatorId}, ${creatorId}) returning id`,
  );
  return rows[0]?.id as string;
}

describeIntegration('contraintes — unicité, CHECK et clés étrangères', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    userId = await insertUser(`it-${runId}-base@example.test`);
  }, 60_000);

  afterAll(async () => {
    await harness.raw(sql`delete from kreiz_redirects where from_path like ${`/it-${runId}/%`}`);
    await harness.raw(sql`delete from kreiz_analytics_events where path like ${`/it-${runId}/%`}`);
    await harness.raw(sql`delete from kreiz_contact_requests where form_id like ${`it-${runId}%`}`);
    await harness.raw(
      sql`delete from kreiz_admin_audit_log where actor_admin_id in (select id from kreiz_admin_users where email like ${emailPattern})`,
    );
    await harness.raw(
      sql`delete from kreiz_admin_sessions where admin_id in (select id from kreiz_admin_users where email like ${emailPattern})`,
    );
    await harness.raw(sql`delete from kreiz_content_entries where route_namespace like ${`it-${runId}%`}`);
    await harness.raw(sql`delete from kreiz_media where storage_key like ${`it-${runId}%`}`);
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    await harness.close();
  }, 60_000);

  it('impose l’unicité de l’email admin', async () => {
    await insertUser(`it-${runId}-dup@example.test`);
    await expectPgError(() => insertUser(`it-${runId}-dup@example.test`), '23505');
  });

  it('impose l’unicité de redirects.from_path', async () => {
    await harness.raw(
      sql`insert into kreiz_redirects (from_path, to_path) values (${`/it-${runId}/a`}, ${`/it-${runId}/b`})`,
    );
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_redirects (from_path, to_path) values (${`/it-${runId}/a`}, ${`/it-${runId}/c`})`,
        ),
      '23505',
    );
  });

  it('rend (route_namespace, slug) unique pour un contenu actif', async () => {
    await insertContent(`it-${runId}`, 'mon-slug', userId);
    await expectPgError(() => insertContent(`it-${runId}`, 'mon-slug', userId), '23505');
    // Un autre namespace n'entre pas en collision : l'unicité est par paire.
    await insertContent(`it-${runId}-autre`, 'mon-slug', userId);
  });

  it('libère le slug après soft delete — l’index unique est bien partiel', async () => {
    const first = await insertContent(`it-${runId}`, 'recycle', userId);

    await harness.raw(sql`update kreiz_content_entries set deleted_at = now() where id = ${first}`);
    // Un contenu soft-deleted n'occupe plus la paire (namespace, slug)…
    const second = await insertContent(`it-${runId}`, 'recycle', userId);
    // … et plusieurs contenus supprimés peuvent coexister sur le même slug.
    await harness.raw(sql`update kreiz_content_entries set deleted_at = now() where id = ${second}`);
    await insertContent(`it-${runId}`, 'recycle', userId);
    const rows = await harness.raw(
      sql`select count(*)::int as n from kreiz_content_entries where slug = 'recycle' and route_namespace = ${`it-${runId}`}`,
    );
    expect(rows[0]?.n).toBe(3);
  });

  it('refuse un état éditorial hors vocabulaire (CHECK)', async () => {
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_content_entries (content_type, route_namespace, title, slug, status, created_by, updated_by)
              values ('article', ${`it-${runId}`}, 'Titre', 'mauvais-etat', 'archived', ${userId}, ${userId})`,
        ),
      '23514',
    );
  });

  it('refuse un état de média hors vocabulaire (CHECK)', async () => {
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_media (status, storage_key, mime, size_bytes, uploaded_by)
              values ('pending', ${`it-${runId}/x.png`}, 'image/png', 10, ${userId})`,
        ),
      '23514',
    );
    // Le vocabulaire valide passe, y compris width/height absents (PDF…).
    await harness.raw(
      sql`insert into kreiz_media (status, storage_key, mime, size_bytes, uploaded_by)
          values ('ready', ${`it-${runId}/ok.pdf`}, 'application/pdf', 10, ${userId})`,
    );
  });

  it('refuse un statut de demande de contact hors vocabulaire (CHECK)', async () => {
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_contact_requests (form_id, payload, status)
              values (${`it-${runId}-form`}, ${'{"message":"bonjour"}'}::jsonb, 'archived')`,
        ),
      '23514',
    );
    await harness.raw(
      sql`insert into kreiz_contact_requests (form_id, payload) values (${`it-${runId}-form-ok`}, ${'{"message":"bonjour"}'}::jsonb)`,
    );
  });

  it('refuse un événement ou un device hors vocabulaire, accepte device absent = NULL', async () => {
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_analytics_events (event_name, path, session_id)
              values ('scroll_depth', ${`/it-${runId}/`}, 'sid')`,
        ),
      '23514',
    );
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_analytics_events (event_name, path, session_id, device_class)
              values ('page_view', ${`/it-${runId}/`}, 'sid', 'fridge')`,
        ),
      '23514',
    );
    await harness.raw(
      sql`insert into kreiz_analytics_events (event_name, path, session_id)
          values ('page_view', ${`/it-${runId}/sans-device`}, 'sid')`,
    );
  });

  it('refuse une référence vers un admin inexistant (FK)', async () => {
    const unknownId = crypto.randomUUID();
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_admin_audit_log (actor_admin_id, action, entity_type, entity_id)
              values (${unknownId}, 'test.action', 'test', ${crypto.randomUUID()})`,
        ),
      '23503',
    );
    await expectPgError(
      () => insertContent(`it-${runId}-fk`, 'createur-inconnu', unknownId),
      '23503',
    );
  });

  it('cascade la suppression des sessions avec leur admin', async () => {
    const ownerId = await insertUser(`it-${runId}-cascade@example.test`);
    await harness.raw(
      sql`insert into kreiz_admin_sessions (admin_id, token_hash, expires_at, absolute_expires_at)
          values (${ownerId}, 'hash-cascade', now() + interval '1 day', now() + interval '90 days')`,
    );
    await harness.raw(sql`delete from kreiz_admin_users where id = ${ownerId}`);
    const rows = await harness.raw(
      sql`select count(*)::int as n from kreiz_admin_sessions where admin_id = ${ownerId}`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('conserve les redirections (SET NULL) et la télémétrie quand le contenu disparaît', async () => {
    const entryId = await insertContent(`it-${runId}`, 'publie', userId);
    await harness.raw(
      sql`insert into kreiz_redirects (from_path, to_path, content_entry_id)
          values (${`/it-${runId}/ancien`}, ${`/it-${runId}/nouveau`}, ${entryId})`,
    );
    await harness.raw(
      sql`insert into kreiz_analytics_events (event_name, path, session_id, content_entry_id)
          values ('page_view', ${`/it-${runId}/publie`}, 'sid', ${entryId})`,
    );

    await harness.raw(sql`delete from kreiz_content_entries where id = ${entryId}`);

    const redirect = await harness.raw(
      sql`select to_path, content_entry_id from kreiz_redirects where from_path = ${`/it-${runId}/ancien`}`,
    );
    expect(redirect[0]?.to_path).toBe(`/it-${runId}/nouveau`);
    expect(redirect[0]?.content_entry_id).toBeNull();

    const event = await harness.raw(
      sql`select content_entry_id from kreiz_analytics_events where path = ${`/it-${runId}/publie`}`,
    );
    expect(event[0]?.content_entry_id).toBeNull();
  });

  it('interdit de supprimer un admin ou un média référencés (RESTRICT)', async () => {
    const authorId = await insertUser(`it-${runId}-restrict@example.test`);
    await harness.raw(
      sql`insert into kreiz_admin_audit_log (actor_admin_id, action, entity_type, entity_id)
          values (${authorId}, 'test.action', 'test', ${crypto.randomUUID()})`,
    );
    await expectPgError(
      () => harness.raw(sql`delete from kreiz_admin_users where id = ${authorId}`),
      // ON DELETE RESTRICT lève restrict_violation (23001), pas foreign_key_violation.
      '23001',
    );

    const mediaRows = await harness.raw(
      sql`insert into kreiz_media (status, storage_key, mime, size_bytes, uploaded_by)
          values ('ready', ${`it-${runId}/cover.png`}, 'image/png', 10, ${authorId}) returning id`,
    );
    const mediaId = mediaRows[0]?.id as string;
    const entryId = await insertContent(`it-${runId}`, 'avec-couverture', authorId);
    await harness.raw(
      sql`update kreiz_content_entries set cover_media_id = ${mediaId} where id = ${entryId}`,
    );
    await expectPgError(
      () => harness.raw(sql`delete from kreiz_media where id = ${mediaId}`),
      '23001',
    );
  });

  it('impose les NOT NULL essentiels (payload contact, hash mot de passe)', async () => {
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_contact_requests (form_id) values (${`it-${runId}-sans-payload`})`,
        ),
      '23502',
    );
    await expectPgError(
      () =>
        harness.raw(
          sql`insert into kreiz_admin_users (email, name) values (${`it-${runId}-sans-hash@example.test`}, 'Sans hash')`,
        ),
      '23502',
    );
  });
});
