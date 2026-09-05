import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createAdminAuditLogRepository,
  createAdminSessionsRepository,
  createAdminUsersRepository,
  createRateLimitsRepository,
} from '../../src/data';
import {
  createAdminAuthServiceForDatabase,
  type AdminAuthService,
} from '../../src/services/admin-auth';
import { verifyPassword } from '../../src/services/password';
import {
  generateSessionToken,
  hashSessionToken,
} from '../../src/services/auth-tokens';
import {
  describeIntegration,
  expectPgError,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Auth admin sur PostgreSQL/Neon réel (mission slice 2 §26) : cycles
 * complets du service (login, sessions, révocations, rate limit atomique,
 * audit append-only) sur la vraie base. Données isolées par run et
 * nettoyées en fin de run — rien ne résiduel.
 */
const runId = crypto.randomUUID().slice(0, 8);
const emailPrefix = `it2-${runId}`;
const SECRET = `it2-secret-${runId}-0123456789abcdef0123456789abcdef`;

let harness: IntegrationHarness;
let auth: AdminAuthService;
const PASSWORD = 'phrase-longue-de-passe-2026';

describeIntegration('auth admin — service complet sur Neon', () => {
  beforeAll(async () => {
    harness = await setupIntegration();
    auth = createAdminAuthServiceForDatabase(harness.db, { secret: SECRET });
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    // Ordre imposé : audit (RESTRICT) → admins (sessions en CASCADE).
    // L'audit est supprimé par acteur OU par entité ciblée (les actions
    // opérateur — actor_admin_id NULL — référencent l'admin via entity_id).
    await withTransientNetworkRetry(() =>
      harness.raw(
        sql`delete from kreiz_admin_audit_log where actor_admin_id in (select id from kreiz_admin_users where email like ${`${emailPrefix}%`}) or entity_id in (select id::text from kreiz_admin_users where email like ${`${emailPrefix}%`})`,
      ),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_admin_users where email like ${`${emailPrefix}%`}`),
    );
    await withTransientNetworkRetry(() => harness.raw(sql`delete from kreiz_rate_limits`));
    await harness.close();
  }, 60_000);

  it('createAdmin : admin haché Argon2id, email normalisé', async () => {
    const outcome = await withTransientNetworkRetry(() =>
      auth.createAdmin({ email: `${emailPrefix}-alice@Example.TEST`, name: 'Alice', password: PASSWORD }),
    );
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.admin.email).toBe(`${emailPrefix}-alice@example.test`);
    expect(outcome.admin.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(outcome.admin.passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('unicité email : pré-contrôle service et contrainte 23505 en base', async () => {
    const serviceOutcome = await auth.createAdmin({
      email: `${emailPrefix}-alice@example.test`,
      name: 'Doublon',
      password: PASSWORD,
    });
    expect(serviceOutcome.kind).toBe('email-exists');

    // La contrainte PostgreSQL réelle reste la garde-fou final.
    const users = createAdminUsersRepository(harness.db);
    await expectPgError(
      () =>
        users.create({
          email: `${emailPrefix}-alice@example.test`,
          name: 'Doublon brut',
          passwordHash: 'autre-hash',
        }),
      '23505',
    );
  });

  it('login réussi : session en base (hash seul), audit admin.login, cookie-ready', async () => {
    const outcome = await auth.login({
      email: `${emailPrefix}-alice@example.test`,
      password: PASSWORD,
    });
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.sessionToken).toHaveLength(43);
    expect(outcome.session.tokenHash).toBe(hashSessionToken(outcome.sessionToken));
    expect(outcome.session.tokenHash).not.toContain(outcome.sessionToken);
    expect(outcome.session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const auditRows = await harness.raw(
      sql`select action, entity_type, metadata from kreiz_admin_audit_log where actor_admin_id = ${outcome.admin.id} order by created_at`,
    );
    expect(auditRows.map((row) => row.action)).toEqual(['admin.login']);
    expect(auditRows[0]?.entity_type).toBe('admin_user');
    expect(JSON.stringify(auditRows[0]?.metadata)).not.toContain(outcome.sessionToken);
  });

  it('mauvais mot de passe → échec générique, compteur incrémenté, pas d’audit', async () => {
    const outcome = await auth.login({
      email: `${emailPrefix}-alice@example.test`,
      password: 'mauvais-mot-de-passe-999',
    });
    expect(outcome.kind).toBe('invalid-credentials');

    const rows = await harness.raw(
      sql`select count::int from kreiz_rate_limits where key like ${`kreiz:login:v1:email:%`}`,
    );
    expect(rows.at(0)?.count).toBeGreaterThan(0);
  });

  it('email inconnu → même échec générique (anti-énumération)', async () => {
    const outcome = await auth.login({
      email: `${emailPrefix}-personne@example.test`,
      password: 'peu-importe-mais-long',
    });
    expect(outcome.kind).toBe('invalid-credentials');
  });

  it('rate limit : 5 échecs vérifiés puis 6e tentative bloquée sans vérification', async () => {
    const email = `${emailPrefix}-ratelimit@example.test`;
    await auth.createAdmin({ email, name: 'RL', password: PASSWORD });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const outcome = await auth.login({ email, password: 'mauvais-mot-de-passe' });
      expect(outcome.kind).toBe('invalid-credentials');
    }
    const sixth = await auth.login({ email, password: PASSWORD });
    // Même le bon mot de passe est bloqué dans la fenêtre.
    expect(sixth.kind).toBe('rate-limited');
  });

  it('rate limit atomique : 12 incréments concurrents produisent 12 valeurs distinctes', async () => {
    const rateLimits = createRateLimitsRepository(harness.db);
    const key = `it2-concurrent-${runId}`;
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withTransientNetworkRetry(() =>
          rateLimits.incrementWindowed(key, { windowMs: 15 * 60_000, now }),
        ),
      ),
    );
    const counts = results.map((row) => row.count).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('fenêtre de rate limit expirée : le compteur repart à 1 dans la même instruction', async () => {
    const rateLimits = createRateLimitsRepository(harness.db);
    const key = `it2-window-${runId}`;
    const oldNow = new Date(Date.now() - 30 * 60_000); // fenêtre échue (> 15 min)
    await rateLimits.incrementWindowed(key, { windowMs: 15 * 60_000, now: oldNow });
    await rateLimits.incrementWindowed(key, { windowMs: 15 * 60_000, now: oldNow });

    const fresh = await rateLimits.incrementWindowed(key, {
      windowMs: 15 * 60_000,
      now: new Date(),
    });
    expect(fresh.count).toBe(1);
  });

  it('resolveSession : authentifié, csrf dérivé, touch au-delà du seuil', async () => {
    // Session fraîche créée par un login.
    const login = await auth.login({
      email: `${emailPrefix}-alice@example.test`,
      password: PASSWORD,
    });
    expect(login.kind).toBe('success');
    if (login.kind !== 'success') return;

    const fresh = await auth.resolveSession(login.sessionToken);
    expect(fresh.status).toBe('authenticated');
    if (fresh.status !== 'authenticated') return;
    expect(fresh.admin.email).toBe(`${emailPrefix}-alice@example.test`);
    expect(fresh.csrfToken).toBe(login.csrfToken);

    // last_seen reculé au-delà du seuil (1 h) → le touch prolonge.
    await harness.raw(
      sql`update kreiz_admin_sessions set last_seen_at = now() - interval '2 hours' where id = ${fresh.session.id}`,
    );
    const touched = await auth.resolveSession(login.sessionToken);
    expect(touched.status).toBe('authenticated');
    if (touched.status !== 'authenticated') return;
    expect(touched.session.lastSeenAt.getTime()).toBeGreaterThan(
      fresh.session.lastSeenAt.getTime(),
    );
    expect(touched.session.expiresAt.getTime()).toBeGreaterThan(
      fresh.session.expiresAt.getTime() - 1000,
    );
  });

  it('session expirée (glissante) et limite absolue → expired', async () => {
    const sessions = createAdminSessionsRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    const admin = await users.findByEmail(`${emailPrefix}-alice@example.test`);
    expect(admin).not.toBeNull();
    if (!admin) return;

    const token = generateSessionToken();
    await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 60_000),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await auth.resolveSession(token)).status).toBe('expired');

    const absoluteToken = generateSessionToken();
    await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(absoluteToken),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() - 60_000),
    });
    expect((await auth.resolveSession(absoluteToken)).status).toBe('expired');
  });

  it('session révoquée → revoked ; token inconnu → invalid', async () => {
    const sessions = createAdminSessionsRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    const admin = await users.findByEmail(`${emailPrefix}-alice@example.test`);
    if (!admin) throw new Error('admin introuvable');

    const token = generateSessionToken();
    const session = await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    expect((await auth.resolveSession(token)).status).toBe('authenticated');
    await sessions.revoke(session.id, new Date());
    expect((await auth.resolveSession(token)).status).toBe('revoked');

    expect((await auth.resolveSession(generateSessionToken())).status).toBe('invalid');
    expect((await auth.resolveSession(undefined)).status).toBe('invalid');
  });

  it('revokeAllForAdmin révoque toutes les sessions actives uniquement', async () => {
    const email = `${emailPrefix}-revokeall@example.test`;
    await auth.createAdmin({ email, name: 'RevokeAll', password: PASSWORD });
    const users = createAdminUsersRepository(harness.db);
    const admin = await users.findByEmail(email);
    if (!admin) throw new Error('admin introuvable');

    const sessions = createAdminSessionsRepository(harness.db);
    const tokenA = generateSessionToken();
    const tokenB = generateSessionToken();
    await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(tokenA),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(tokenB),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    // Session déjà révoquée : ne compte pas, reste révoquée.
    const revokedToken = generateSessionToken();
    const revokedSession = await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(revokedToken),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await sessions.revoke(revokedSession.id, new Date());

    const revokedCount = await sessions.revokeAllForAdmin(admin.id, new Date());
    expect(revokedCount).toBe(2);
    expect((await auth.resolveSession(tokenA)).status).toBe('revoked');
    expect((await auth.resolveSession(tokenB)).status).toBe('revoked');
  });

  it('admin désactivé (disabled_at sans révocation) : login refusé, session → admin-disabled', async () => {
    const email = `${emailPrefix}-disabled@example.test`;
    await auth.createAdmin({ email, name: 'Disabled', password: PASSWORD });
    const login = await auth.login({ email, password: PASSWORD });
    expect(login.kind).toBe('success');
    if (login.kind !== 'success') return;

    // Désactivation « brute » en base (sans passer par le service) : la
    // session n'est pas révoquée — le guard doit quand même bloquer.
    await harness.raw(
      sql`update kreiz_admin_users set disabled_at = now() where id = ${login.admin.id}`,
    );

    // Le login est refusé même avec les bons identifiants.
    const refused = await auth.login({ email, password: PASSWORD });
    expect(refused.kind).toBe('invalid-credentials');

    // La session existante devient inutilisable, avec la cause explicite.
    expect((await auth.resolveSession(login.sessionToken)).status).toBe('admin-disabled');
  });

  it('disableAdmin (service) : désactive l’admin et révoque ses sessions actives', async () => {
    const email = `${emailPrefix}-disable-svc@example.test`;
    await auth.createAdmin({ email, name: 'DisableSvc', password: PASSWORD });
    const login = await auth.login({ email, password: PASSWORD });
    expect(login.kind).toBe('success');
    if (login.kind !== 'success') return;

    const outcome = await auth.disableAdmin(login.admin.id);
    expect(outcome).toMatchObject({ kind: 'disabled', revokedSessions: 1 });

    const refused = await auth.login({ email, password: PASSWORD });
    expect(refused.kind).toBe('invalid-credentials');
    // Le service révoque avant tout : statut révoqué, l'important est le blocage.
    expect((await auth.resolveSession(login.sessionToken)).status).toBe('revoked');
  });

  it('reset password : ancien invalide, nouveau valide, sessions révoquées, audité', async () => {
    const email = `${emailPrefix}-reset@example.test`;
    await auth.createAdmin({ email, name: 'Reset', password: PASSWORD });
    const login = await auth.login({ email, password: PASSWORD });
    expect(login.kind).toBe('success');
    if (login.kind !== 'success') return;

    const reset = await auth.resetPassword({ email, password: 'nouvelle-phrase-longue-2026' });
    expect(reset).toMatchObject({ kind: 'reset', revokedSessions: 1 });

    // L'ancien mot de passe ne fonctionne plus.
    expect(
      (await auth.login({ email, password: PASSWORD })).kind,
    ).toBe('invalid-credentials');
    // La session d'avant le reset est révoquée.
    expect((await auth.resolveSession(login.sessionToken)).status).toBe('revoked');
    // Le nouveau fonctionne et rouvre une session.
    const renewed = await auth.login({ email, password: 'nouvelle-phrase-longue-2026' });
    expect(renewed.kind).toBe('success');

    // admin.password_reset via CLI : action opérateur/système —
    // actor_admin_id NULL (l'admin cible est dans entity_id, jamais en
    // acteur), source déclarée dans les metadata. Les deux logins
    // restent des actions de session avec leur vrai acteur.
    const targetId = reset.kind === 'reset' ? reset.admin.id : null;
    expect(targetId).not.toBeNull();
    const rows = await harness.raw(
      sql`select action, actor_admin_id, entity_id, metadata from kreiz_admin_audit_log where actor_admin_id = ${targetId} or entity_id = ${String(targetId)} order by created_at`,
    );
    expect(rows.map((row) => row.action)).toEqual([
      'admin.login',
      'admin.password_reset',
      'admin.login',
    ]);
    expect(rows[0]?.actor_admin_id).not.toBeNull();
    expect(rows[2]?.actor_admin_id).not.toBeNull();
    expect(rows[1]?.actor_admin_id).toBeNull();
    expect(rows[1]?.entity_id).toBe(targetId);
    expect(JSON.parse(JSON.stringify(rows[1]?.metadata))).toMatchObject({
      source: 'cli',
      revokedSessions: 1,
    });
  });

  it('reset password : email inconnu refusé proprement', async () => {
    const outcome = await auth.resetPassword({
      email: `${emailPrefix}-inconnu@example.test`,
      password: PASSWORD,
    });
    expect(outcome.kind).toBe('unknown-admin');
  });

  it('audit append-only : seule l’insertion est exposée', () => {
    const audit = createAdminAuditLogRepository(harness.db);
    expect(Object.keys(audit)).toEqual(['append']);
    // Pas d'update/delete : la surface le prouve mécaniquement.
    expect(audit).not.toHaveProperty('update');
    expect(audit).not.toHaveProperty('delete');
  });

  it('purgeExpired supprime les sessions au-delà de la limite absolue', async () => {
    const sessions = createAdminSessionsRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    const admin = await users.findByEmail(`${emailPrefix}-alice@example.test`);
    if (!admin) throw new Error('admin introuvable');

    const deadToken = generateSessionToken();
    await sessions.create({
      adminId: admin.id,
      tokenHash: hashSessionToken(deadToken),
      expiresAt: new Date(Date.now() - 120 * 86_400_000),
      absoluteExpiresAt: new Date(Date.now() - 91 * 86_400_000),
    });

    const purged = await sessions.purgeExpired(new Date());
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await sessions.findByTokenHash(hashSessionToken(deadToken))).toBeNull();
  });
});

// Vérifie aussi le câblage par défaut (sans secret) : les opérations de
// gestion fonctionnent, le login exige le secret.
describeIntegration('auth admin — service sans secret (profil CLI)', () => {
  it('createAdmin fonctionne sans secret ; login lève explicitement', async () => {
    const harness = await setupIntegration();
    try {
      const cliAuth = createAdminAuthServiceForDatabase(harness.db);
      const email = `${emailPrefix}-nosecret@example.test`;
      const outcome = await withTransientNetworkRetry(() =>
        cliAuth.createAdmin({ email, name: 'NoSecret', password: PASSWORD }),
      );
      expect(outcome.kind).toBe('created');
      await expect(cliAuth.login({ email, password: PASSWORD })).rejects.toThrow(/KREIZ_SECRET/);
    } finally {
      await withTransientNetworkRetry(() =>
        harness.raw(
          sql`delete from kreiz_admin_users where email like ${`${emailPrefix}-nosecret%`}`,
        ),
      );
      await harness.close();
    }
  });
});
