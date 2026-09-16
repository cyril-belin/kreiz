import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createContactRequestsRepository } from '../../src/data/repositories/contact-requests';
import { createRateLimitsRepository } from '../../src/data/repositories/rate-limits';
import { createAdminAuditLogRepository } from '../../src/data/repositories/admin-audit-log';
import { createContactService } from '../../src/services/contact';
import type { Mailer } from '../../src/ports/mailer';
import { defineContactForm } from '../../src/domain/forms/declaration';
import { formFields } from '../../src/domain/forms/fields';
import { issueFormToken } from '../../src/domain/forms/token';
import {
  describeIntegration,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Intégration Neon réelle du domaine contact (slice 7) — la vraie table
 * migrée, les vraies contraintes :
 * - persistance + relecture, `ON CONFLICT` de déduplication **en SQL réel**
 *   (deux inserts de même `dedup_key` → une ligne, l'appelant relit la
 *   gagnante) ;
 * - claim conditionnel sous concurrence simulée (un seul gagnant) ;
 * - cycle de notification complet (pending → sent / failed → rearm) ;
 * - service de bout en bout contre la vraie base : rate limiting en table,
 *   idempotence, promotion des `not_configured`, balayage.
 */
const runId = crypto.randomUUID().slice(0, 8);
const SECRET = 'secret-integration-tres-long-0123456789abcdef';

let harness: IntegrationHarness;
let requests: ReturnType<typeof createContactRequestsRepository>;
let rateLimits: ReturnType<typeof createRateLimitsRepository>;
let audit: ReturnType<typeof createAdminAuditLogRepository>;

const demoForm = defineContactForm({
  key: `contact_${runId.replace(/-/g, '_').slice(0, 8)}`,
  label: 'Contact IT',
  fields: {
    name: formFields.text({ label: 'Nom', required: true }),
    email: formFields.email({ label: 'Email', required: true }),
    message: formFields.textarea({ label: 'Message', required: true }),
  },
  confirmationPath: '/merci',
  notification: { recipients: ['dest@example.test'], subject: 'Sujet IT' },
});

const FORM_KEY = demoForm.key;

beforeAll(async () => {
  harness = await setupIntegration();
  requests = createContactRequestsRepository(harness.db);
  rateLimits = createRateLimitsRepository(harness.db);
  audit = createAdminAuditLogRepository(harness.db);
  // Admin réel du run — l'audit des relances référence l'acteur (FK restrict).
  const admins = await harness.raw(
    sql`insert into kreiz_admin_users (email, password_hash, name)
        values (${`it-admin-${runId}@example.test`}, 'not-a-real-hash', 'Admin IT') returning id`,
  );
  adminId = String(admins[0]!.id);
});

let adminId = '';

afterAll(async () => {
  if (harness) {
    // Zéro donnée résiduelle : périmètre du run supprimé à la fin aussi
    // (le beforeEach couvre les tests, l'afterAll couvre la fin de suite).
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_admin_audit_log where entity_type = 'contact_request' and entity_id in (select id::text from kreiz_contact_requests where form_id like ${`contact_${runId.slice(0, 8)}%`})`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_contact_requests where form_id like ${`contact_${runId.slice(0, 8)}%`}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_rate_limits where key like ${`contact_%${runId.slice(0, 8)}%`}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_admin_users where email = ${`it-admin-${runId}@example.test`}`),
    );
    await harness.close();
  }
});

beforeEach(async () => {
  // Nettoyage ciblé du périmètre du run (aucune donnée résiduelle) —
  // l'audit part AVANT les demandes qu'il référence.
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_admin_audit_log where entity_type = 'contact_request' and entity_id in (select id::text from kreiz_contact_requests where form_id like ${`contact_${runId.slice(0, 8)}%`})`),
  );
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_contact_requests where form_id like ${`contact_${runId.slice(0, 8)}%`}`),
  );
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_rate_limits where key like ${`contact_%${runId.slice(0, 8)}%`}`),
  );
});

/** Mailer factice piloté par la closure (réel transport, zéro réseau). */
function makeMailer(behavior: () => ReturnType<Mailer['send']> extends Promise<infer T> ? T : never) {
  const sent: number[] = [];
  return {
    sent,
    async send() {
      sent.push(sent.length + 1);
      return behavior();
    },
  } as Mailer & { sent: number[] };
}

function makeService(mailer: Mailer | null) {
  return createContactService({
    requests,
    rateLimits,
    audit,
    mailer,
    mailFrom: mailer ? { email: 'no-reply@example.test' } : null,
    secret: SECRET,
    forms: { findById: (key) => (key === FORM_KEY ? demoForm : null) },
  });
}

const NOW = new Date('2026-09-16T09:00:00Z');

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    form: demoForm,
    values: {
      name: `Alice ${runId}`,
      email: `alice-${runId}@example.test`,
      message: 'Bonjour depuis l’intégration',
    },
    honeypotFilled: false,
    token: issueFormToken({ formKey: FORM_KEY, secret: SECRET, issuedAt: new Date(NOW.getTime() - 60_000) }).token,
    clientIp: `203.0.113.${(runId.charCodeAt(0) % 200) + 10}`,
    now: NOW,
    ...overrides,
  };
}

describeIntegration('contact_requests — repository sur PostgreSQL réel', () => {
  it('insert + relecture complète du cycle de colonnes', async () => {
    const { request } = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: { name: 'A', message: 'B' },
      notificationStatus: 'pending',
      notificationNextAttemptAt: NOW,
      dedupKey: `dedup-${runId}-1`,
      createdAt: NOW,
    });
    const reloaded = await requests.findById(request.id);
    expect(reloaded?.formId).toBe(FORM_KEY);
    expect(reloaded?.status).toBe('new');
    expect(reloaded?.notificationStatus).toBe('pending');
    expect(reloaded?.notificationAttempts).toBe(0);
    expect(reloaded?.dedupKey).toBe(`dedup-${runId}-1`);
    expect(reloaded?.createdAt.toISOString()).toBe(NOW.toISOString());
  });

  it('déduplication réelle : même clé → duplicate=true avec la ligne gagnante', async () => {
    const first = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: { n: 1 },
      notificationStatus: 'not_configured',
      notificationNextAttemptAt: null,
      dedupKey: `dedup-${runId}-2`,
      createdAt: NOW,
    });
    expect(first.duplicate).toBe(false);
    const second = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: { n: 2 },
      notificationStatus: 'not_configured',
      notificationNextAttemptAt: null,
      dedupKey: `dedup-${runId}-2`,
      createdAt: NOW,
    });
    expect(second.duplicate).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.payload).toEqual({ n: 1 }); // jamais écrasée
  });

  it('claim conditionnel : un seul des deux chemins concurrents gagne', async () => {
    const { request } = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: {},
      notificationStatus: 'pending',
      notificationNextAttemptAt: NOW,
      dedupKey: `dedup-${runId}-3`,
      createdAt: NOW,
    });
    const [winner, loser] = await Promise.all([
      requests.claimNotificationAttempt(request.id, { expectedAttempts: 0 }),
      requests.claimNotificationAttempt(request.id, { expectedAttempts: 0 }),
    ]);
    expect(winner).not.toBeNull();
    expect(loser).toBeNull();
    const row = await requests.findById(request.id);
    expect(row?.notificationAttempts).toBe(1);
  });

  it('cycle de notification complet et liste des demandes dues', async () => {
    const { request } = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: {},
      notificationStatus: 'pending',
      notificationNextAttemptAt: NOW,
      dedupKey: `dedup-${runId}-4`,
      createdAt: NOW,
    });
    const claimed = await requests.claimNotificationAttempt(request.id, { expectedAttempts: 0 });
    expect(claimed?.notificationAttempts).toBe(1);
    await requests.markNotificationFailed(request.id, {
      failure: { kind: 'rejected', statusCode: 500 },
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
    let row = await requests.findById(request.id);
    expect(row?.notificationStatus).toBe('failed');
    expect(row?.notificationFailure).toEqual({ kind: 'rejected', statusCode: 500 });

    // Pas encore due.
    let due = await requests.listNotificationDue({ now: NOW, maxAttempts: 5 });
    expect(due.some((candidate) => candidate.id === request.id)).toBe(false);
    // Due.
    due = await requests.listNotificationDue({ now: new Date(NOW.getTime() + 120_000), maxAttempts: 5 });
    expect(due.some((candidate) => candidate.id === request.id)).toBe(true);

    await requests.markNotified(request.id, { notifiedAt: new Date() });
    row = await requests.findById(request.id);
    expect(row?.notificationStatus).toBe('sent');
    expect(row?.notifiedAt).toBeTruthy();
    // Une notification envoyée ne repart plus.
    const rearmed = await requests.rearmNotification(request.id);
    expect(rearmed).toBeNull();
  });

  it('transition new ⇄ handled persistée', async () => {
    const { request } = await requests.insertOrFindDuplicate({
      formId: FORM_KEY,
      payload: {},
      notificationStatus: 'not_configured',
      notificationNextAttemptAt: null,
      dedupKey: `dedup-${runId}-5`,
      createdAt: NOW,
    });
    await requests.updateStatus(request.id, 'handled');
    expect((await requests.findById(request.id))?.status).toBe('handled');
    await requests.updateStatus(request.id, 'new');
    expect((await requests.findById(request.id))?.status).toBe('new');
  });
});

describeIntegration('contact service — bout en bout sur la vraie base', () => {
  it('soumission valide : persistée, notifiée, auditée — rate limiting en table réelle', async () => {
    const mailer = makeMailer(() => ({ ok: true, messageId: 'it-1' }));
    const service = makeService(mailer);
    const outcome = await service.submit(validSubmission());
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    expect(outcome.notification).toEqual({ status: 'sent' });
    expect(mailer.sent).toHaveLength(1);
    const row = await requests.findById(outcome.request.id);
    expect(row?.notificationStatus).toBe('sent');
    // Le compteur de rate limiting vit dans kreiz_rate_limits (hachage d'IP,
    // jamais l'IP).
    const counterKey = `contact:${FORM_KEY}:`;
    const counters = await harness.raw(
      sql`select key, count from kreiz_rate_limits where key like ${`${counterKey}%`}`,
    );
    expect(counters).toHaveLength(1);
    expect(Number(counters[0]!.count)).toBe(1);
    expect(counters[0]!.key).not.toContain('203.0.113');
  });

  it('idempotence de bout en bout : double POST → une ligne, second succès silencieux', async () => {
    const mailer = makeMailer(() => ({ ok: true, messageId: 'it-2' }));
    const service = makeService(mailer);
    const first = await service.submit(validSubmission({ values: { name: 'Bob', email: `bob-${runId}@example.test`, message: 'Salut' } }));
    expect(first.kind).toBe('submitted');
    const second = await service.submit(validSubmission({
      values: { name: 'Bob', email: `bob-${runId}@example.test`, message: 'Salut' },
      now: new Date(NOW.getTime() + 5000),
    }));
    expect(second.kind).toBe('duplicate');
    expect(mailer.sent).toHaveLength(1); // pas de double notification
    const rows = await harness.raw(
      sql`select count(*)::int as total from kreiz_contact_requests where form_id = ${FORM_KEY} and payload->>'name' = 'Bob'`,
    );
    expect(Number(rows[0]!.total)).toBe(1);
  });

  it('panne mail : demande conservée, échec tracé, relance admin réussie', async () => {
    let failing = true;
    const flaky = makeMailer(() =>
      failing ? { ok: false, failure: { kind: 'unreachable' } } : { ok: true, messageId: 'it-3' },
    );
    const service = makeService(flaky);
    const outcome = await service.submit(validSubmission({ values: { name: 'Céline', email: `celine-${runId}@example.test`, message: 'Panne' } }));
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    let row = await requests.findById(outcome.request.id);
    expect(row?.notificationStatus).toBe('failed');
    expect(row?.payload).toMatchObject({ name: 'Céline' });

    failing = false;
    const retry = await service.retryNotification({
      requestId: outcome.request.id,
      form: demoForm,
      actorAdminId: adminId,
    });
    // Acteur = admin réel du run (FK restrict vérifiée au passage).
    expect(retry).toEqual({ status: 'sent' });
    row = await requests.findById(outcome.request.id);
    expect(row?.notificationStatus).toBe('sent');
    expect(flaky.sent).toHaveLength(2);
  });

  it('balayage : promotion not_configured → pending → sent sur vraie base', async () => {
    const service = makeService(null);
    const outcome = await service.submit(validSubmission({ values: { name: 'Dora', email: `dora-${runId}@example.test`, message: 'Sans transport' } }));
    if (outcome.kind !== 'submitted') return expect.unreachable(String(outcome.kind));
    let row = await requests.findById(outcome.request.id);
    expect(row?.notificationStatus).toBe('not_configured');

    // Le transport devient disponible (nouveau déploiement, même base).
    const mailer = makeMailer(() => ({ ok: true, messageId: 'it-4' }));
    const serviceWithMailer = makeService(mailer);
    const recovery = await serviceWithMailer.runNotificationRecovery({
      now: new Date(NOW.getTime() + 1000),
    });
    expect(recovery.promoted).toBeGreaterThanOrEqual(1);
    expect(recovery.sent).toBeGreaterThanOrEqual(1);
    row = await requests.findById(outcome.request.id);
    expect(row?.notificationStatus).toBe('sent');
    expect(mailer.sent.length).toBeGreaterThanOrEqual(1);
  });
});
