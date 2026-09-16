import { describe, expect, it } from 'vitest';
import { createContactService, type ContactServiceDeps } from '../src/services/contact';
import type { ContactRequestsRepository } from '../src/data/repositories/contact-requests';
import type { RateLimitsRepository } from '../src/data/repositories/rate-limits';
import type { KreizContactRequest } from '../src/data/tables/contact-requests';
import type { AdminAuditLogRepository } from '../src/data/repositories/admin-audit-log';
import type { Mailer, MailerSendResult, OutgoingEmail } from '../src/ports/mailer';
import { defineContactForm } from '../src/domain/forms/declaration';
import { formFields } from '../src/domain/forms/fields';
import { issueFormToken } from '../src/domain/forms/token';
import { CONTACT_NOTIFICATION_MAX_ATTEMPTS, CONTACT_RATE_LIMIT_MAX } from '../src/domain/forms/policy';

/**
 * Service de contact — orchestration anti-spam, idempotence, persistance
 * AVANT notification, relances. Fakes en mémoire reproduisant les
 * sémantiques SQL garanties (index unique de dédup, claim conditionnel).
 */

const SECRET = 'secret-de-test-tres-long-0123456789abcdef';
const NOW = new Date('2026-09-16T12:00:00Z');

const demoForm = defineContactForm({
  key: 'contact',
  label: 'Contact',
  fields: {
    name: formFields.text({ label: 'Nom', required: true }),
    email: formFields.email({ label: 'Email', required: true }),
    message: formFields.textarea({ label: 'Message', required: true }),
  },
  confirmationPath: '/merci',
  notification: { recipients: ['dest@example.test'], subject: 'Nouveau message' },
});

// ——— Fakes ———

function makeRequestsRepo(): ContactRequestsRepository & { rows: Map<string, KreizContactRequest> } {
  const rows = new Map<string, KreizContactRequest>();
  let sequence = 0;
  const repo = {
    rows,
    async insertOrFindDuplicate(row: {
      formId: string;
      payload: Record<string, unknown>;
      notificationStatus: KreizContactRequest['notificationStatus'];
      notificationNextAttemptAt: Date | null;
      dedupKey: string | null;
      createdAt?: Date;
    }) {
      const existing = row.dedupKey
        ? [...rows.values()].find((candidate) => candidate.dedupKey === row.dedupKey)
        : undefined;
      if (existing) return { request: existing, duplicate: true };
      sequence += 1;
      const created: KreizContactRequest = {
        id: `req-${sequence}`,
        formId: row.formId,
        payload: row.payload,
        status: 'new',
        createdAt: row.createdAt ?? NOW,
        notificationStatus: row.notificationStatus,
        notificationAttempts: 0,
        notificationFailure: null,
        notifiedAt: null,
        notificationNextAttemptAt: row.notificationNextAttemptAt,
        dedupKey: row.dedupKey,
      };
      rows.set(created.id, created);
      return { request: created, duplicate: false };
    },
    async findById(id: string) {
      return rows.get(id) ?? null;
    },
    async list(options: { limit?: number; formId?: string; status?: KreizContactRequest['status'] } = {}) {
      return [...rows.values()]
        .filter(
          (row) =>
            (!options.formId || row.formId === options.formId) &&
            (!options.status || row.status === options.status),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, options.limit ?? 200);
    },
    async countNew() {
      return [...rows.values()].filter((row) => row.status === 'new').length;
    },
    async updateStatus(id: string, status: KreizContactRequest['status']) {
      const row = rows.get(id);
      if (!row) return null;
      const updated = { ...row, status };
      rows.set(id, updated);
      return updated;
    },
    async claimNotificationAttempt(id: string, options: { expectedAttempts: number }) {
      const row = rows.get(id);
      if (!row) return null;
      if (row.notificationAttempts !== options.expectedAttempts) return null;
      if (!['pending', 'failed', 'not_configured'].includes(row.notificationStatus)) return null;
      const updated: KreizContactRequest = {
        ...row,
        notificationAttempts: row.notificationAttempts + 1,
        notificationStatus: row.notificationStatus === 'not_configured' ? 'pending' : row.notificationStatus,
        notificationFailure: null,
      };
      rows.set(id, updated);
      return updated;
    },
    async markNotified(id: string, options: { notifiedAt: Date }) {
      const row = rows.get(id);
      if (!row) return null;
      const updated: KreizContactRequest = {
        ...row,
        notificationStatus: 'sent',
        notifiedAt: options.notifiedAt,
        notificationNextAttemptAt: null,
        notificationFailure: null,
      };
      rows.set(id, updated);
      return updated;
    },
    async markNotificationFailed(
      id: string,
      options: { failure: NonNullable<KreizContactRequest['notificationFailure']>; nextAttemptAt: Date | null },
    ) {
      const row = rows.get(id);
      if (!row) return null;
      const updated: KreizContactRequest = {
        ...row,
        notificationStatus: 'failed',
        notificationFailure: options.failure,
        notificationNextAttemptAt: options.nextAttemptAt,
      };
      rows.set(id, updated);
      return updated;
    },
    async rearmNotification(id: string, options: { now?: Date } = {}) {
      const row = rows.get(id);
      if (!row || row.notificationStatus === 'sent') return null;
      const updated: KreizContactRequest = {
        ...row,
        notificationAttempts: 0,
        notificationNextAttemptAt: options.now ?? NOW,
        notificationStatus: row.notificationStatus === 'not_configured' ? 'pending' : row.notificationStatus,
      };
      rows.set(id, updated);
      return updated;
    },
    async listNotificationDue(options: { now: Date; limit?: number; maxAttempts: number }) {
      return [...rows.values()]
        .filter(
          (row) =>
            ['pending', 'failed'].includes(row.notificationStatus) &&
            row.notificationNextAttemptAt !== null &&
            row.notificationNextAttemptAt <= options.now &&
            row.notificationAttempts < options.maxAttempts,
        )
        .slice(0, options.limit ?? 25);
    },
    async promoteNotConfigured(options: { limit?: number; now?: Date } = {}) {
      let promoted = 0;
      for (const row of rows.values()) {
        if (row.notificationStatus !== 'not_configured') continue;
        if (promoted >= (options.limit ?? 50)) break;
        rows.set(row.id, {
          ...row,
          notificationStatus: 'pending',
          notificationNextAttemptAt: options.now ?? NOW,
        });
        promoted += 1;
      }
      return promoted;
    },
  };
  return repo as ContactRequestsRepository & typeof repo;
}

function makeRateLimitsRepo(): RateLimitsRepository & { counters: Map<string, number> } {
  const counters = new Map<string, number>();
  return {
    counters,
    async incrementWindowed(key: string, _options: { windowMs: number; now: Date }) {
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return { key, windowStartedAt: NOW, count };
    },
    async get(key: string) {
      const count = counters.get(key);
      return count === undefined ? null : { key, windowStartedAt: NOW, count };
    },
    async reset(keys: string[]) {
      for (const key of keys) counters.delete(key);
    },
    async purgeExpired() {
      return 0;
    },
  } as RateLimitsRepository & { counters: Map<string, number> };
}

function makeAudit() {
  const events: Array<{ action: string; actorAdminId: string | null; entityId: string; metadata: Record<string, unknown> }> = [];
  const repo = {
    events,
    async append(event: { actorAdminId: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown> }) {
      events.push({
        action: event.action,
        actorAdminId: event.actorAdminId,
        entityId: event.entityId,
        metadata: event.metadata ?? {},
      });
      return {} as ReturnType<AdminAuditLogRepository['append']> extends Promise<infer T> ? T : never;
    },
  };
  return repo as AdminAuditLogRepository & typeof repo;
}

function makeMailer(behavior: (email: OutgoingEmail, call: number) => MailerSendResult) {
  const sent: OutgoingEmail[] = [];
  const mailer: Mailer & { sent: OutgoingEmail[] } = {
    sent,
    async send(email) {
      sent.push(email);
      return behavior(email, sent.length);
    },
  };
  return mailer;
}

function buildService(overrides: Partial<ContactServiceDeps> = {}) {
  const requests = makeRequestsRepo();
  const rateLimits = makeRateLimitsRepo();
  const audit = makeAudit();
  const mailer = makeMailer(() => ({ ok: true, messageId: 'msg-1' }));
  const service = createContactService({
    requests,
    rateLimits,
    audit,
    mailer,
    mailFrom: { email: 'no-reply@example.test', name: 'Kreiz' },
    secret: SECRET,
    ...overrides,
  });
  return { service, requests, rateLimits, audit, mailer };
}

function tokenFor(formKey = 'contact', issuedAt = new Date(NOW.getTime() - 60 * 1000)): string {
  return issueFormToken({ formKey, secret: SECRET, issuedAt }).token;
}

const validInput = {
  form: demoForm,
  values: { name: 'Alice', email: 'alice@example.test', message: 'Bonjour' },
  honeypotFilled: false,
  token: tokenFor(),
  clientIp: '203.0.113.10',
  now: NOW,
};

describe('soumission valide — persistance puis notification', () => {
  it('stocke la demande, envoie la notification, marque sent, audite', async () => {
    const { service, requests, audit, mailer } = buildService();
    const outcome = await service.submit(validInput);
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    expect(outcome.request.payload).toEqual(validInput.values);
    expect(outcome.request.status).toBe('new');
    expect(outcome.request.dedupKey).toMatch(/./);
    expect(outcome.notification).toEqual({ status: 'sent' });
    // Persisté avant envoi : la ligne existe dans le repo.
    expect(requests.rows.get(outcome.request.id)?.notificationStatus).toBe('sent');
    // Enveloppe : destinataire = déclaration, from = env, reply-to = champ email.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toEqual([{ email: 'dest@example.test' }]);
    expect(mailer.sent[0]!.from).toEqual({ email: 'no-reply@example.test', name: 'Kreiz' });
    expect(mailer.sent[0]!.replyTo).toEqual({ email: 'alice@example.test' });
    expect(mailer.sent[0]!.subject).toBe('Nouveau message');
    expect(mailer.sent[0]!.text).toContain('Bonjour');
    // Audit : soumission (acteur null) — aucune donnée visiteur dans les metadata.
    expect(audit.events.map((event) => event.action)).toEqual(['contact.submitted']);
    expect(audit.events[0]!.actorAdminId).toBeNull();
    expect(JSON.stringify(audit.events[0]!.metadata)).not.toContain('Alice');
  });

  it('sans mailer configuré : demande stockée, notification not_configured, aucun envoi', async () => {
    const { service, mailer } = buildService({ mailer: null, mailFrom: null });
    const outcome = await service.submit(validInput);
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    expect(outcome.notification).toBeNull();
    expect(outcome.request.notificationStatus).toBe('not_configured');
    expect(mailer.sent).toHaveLength(0);
  });

  it('pas de notification déclarée sur le formulaire : not_configured même avec mailer', async () => {
    const noNotificationForm = defineContactForm({
      ...demoForm,
      key: 'sansmail',
      label: 'Sans mail',
      notification: undefined,
    });
    const { service, mailer } = buildService();
    const outcome = await service.submit({
      ...validInput,
      form: noNotificationForm,
      token: tokenFor('sansmail'),
    });
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    expect(outcome.request.notificationStatus).toBe('not_configured');
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('anti-spam', () => {
  it('honeypot rempli → spam-signal, aucune ligne, aucun envoi', async () => {
    const { service, requests, mailer } = buildService();
    const outcome = await service.submit({ ...validInput, honeypotFilled: true });
    expect(outcome.kind).toBe('spam-signal');
    expect(requests.rows.size).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('soumission trop rapide après l’émission du jeton → spam-signal silencieux', async () => {
    const { service, requests } = buildService();
    const fresh = tokenFor('contact', new Date(NOW.getTime() - 500));
    const outcome = await service.submit({ ...validInput, token: fresh });
    expect(outcome.kind).toBe('spam-signal');
    expect(requests.rows.size).toBe(0);
  });

  it('jeton invalide → invalid-token, aucune ligne', async () => {
    const { service, requests } = buildService();
    const outcome = await service.submit({ ...validInput, token: 'falsifié.par.nimporte-qui' });
    expect(outcome.kind).toBe('invalid-token');
    expect(requests.rows.size).toBe(0);
  });

  it('payload invalide → invalid-payload avec erreurs par champ, aucune ligne', async () => {
    const { service, requests } = buildService();
    const outcome = await service.submit({
      ...validInput,
      values: { name: '', email: 'pas-un-email', message: '' },
    });
    expect(outcome.kind).toBe('invalid-payload');
    if (outcome.kind !== 'invalid-payload') return;
    expect(Object.keys(outcome.fieldErrors).sort()).toEqual(['email', 'message', 'name']);
    expect(requests.rows.size).toBe(0);
  });

  it('rate limiting : la 6e soumission dans la fenêtre est refusée avec Retry-After', async () => {
    const { service } = buildService();
    for (let index = 0; index < CONTACT_RATE_LIMIT_MAX; index += 1) {
      const outcome = await service.submit({
        ...validInput,
        values: { ...validInput.values, message: `Message ${index}` },
        now: new Date(NOW.getTime() + index * 1000),
      });
      expect(outcome.kind).toBe('submitted');
    }
    const blocked = await service.submit({
      ...validInput,
      values: { ...validInput.values, message: 'Encore un' },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(blocked.kind).toBe('rate-limited');
    if (blocked.kind !== 'rate-limited') return;
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(service.rateLimitedMessage(blocked.retryAfterSeconds)).toMatch(/minute/);
  });

  it('rate limiting par IP : un autre client garde sa propre fenêtre', async () => {
    const { service } = buildService();
    for (let index = 0; index < CONTACT_RATE_LIMIT_MAX; index += 1) {
      await service.submit({
        ...validInput,
        values: { ...validInput.values, message: `A${index}` },
        now: new Date(NOW.getTime() + index * 1000),
      });
    }
    const otherClient = await service.submit({
      ...validInput,
      clientIp: '198.51.100.77',
      values: { ...validInput.values, message: 'Autre client' },
    });
    expect(otherClient.kind).toBe('submitted');
  });
});

describe('idempotence (doubles soumissions)', () => {
  it('même contenu + même client + même fenêtre → duplicate, une seule ligne', async () => {
    const { service, requests } = buildService();
    const first = await service.submit(validInput);
    expect(first.kind).toBe('submitted');
    const second = await service.submit({ ...validInput, now: new Date(NOW.getTime() + 2000) });
    expect(second.kind).toBe('duplicate');
    if (second.kind !== 'duplicate') return;
    if (first.kind !== 'submitted') return;
    expect(second.request.id).toBe(first.request.id);
    expect(requests.rows.size).toBe(1);
  });

  it('même contenu, autre client → deux demandes distinctes', async () => {
    const { service, requests } = buildService();
    await service.submit(validInput);
    const other = await service.submit({ ...validInput, clientIp: '198.51.100.99' });
    expect(other.kind).toBe('submitted');
    expect(requests.rows.size).toBe(2);
  });

  it('même contenu, fenêtre suivante → deux demandes distinctes', async () => {
    const { service, requests } = buildService();
    await service.submit(validInput);
    const later = await service.submit({
      ...validInput,
      now: new Date(NOW.getTime() + 11 * 60 * 1000),
    });
    expect(later.kind).toBe('submitted');
    expect(requests.rows.size).toBe(2);
  });

  it('l’ordre des clés du payload n’affecte pas la clé d’idempotence', async () => {
    const { service, requests } = buildService();
    await service.submit(validInput);
    const reordered = await service.submit({
      ...validInput,
      values: { message: 'Bonjour', email: 'alice@example.test', name: 'Alice' },
      now: new Date(NOW.getTime() + 1000),
    });
    expect(reordered.kind).toBe('duplicate');
    expect(requests.rows.size).toBe(1);
  });
});

describe('panne mail — la demande survit toujours', () => {
  it('transport en échec : demande stockée, failed + kind + backoff, audit sans PII', async () => {
    const failingMailer = makeMailer(() => ({ ok: false, failure: { kind: 'unreachable' } }));
    const requests = makeRequestsRepo();
    const audit = makeAudit();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit,
      mailer: failingMailer,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
    });
    const outcome = await service.submit(validInput);
    expect(outcome.kind).toBe('submitted');
    if (outcome.kind !== 'submitted') return;
    expect(outcome.request.notificationStatus).toBe('pending');
    expect(outcome.notification).toEqual({
      status: 'failed',
      failure: { kind: 'unreachable' },
    });
    const row = requests.rows.get(outcome.request.id);
    expect(row?.notificationStatus).toBe('failed');
    expect(row?.notificationAttempts).toBe(1);
    expect(row?.notificationNextAttemptAt).toBeTruthy();
    expect(row?.payload).toEqual(validInput.values); // la demande est intacte
    expect(audit.events.some((event) => event.action === 'contact.notification_failed')).toBe(true);
    const auditJson = JSON.stringify(audit.events);
    expect(auditJson).not.toContain('Alice');
    expect(auditJson).not.toContain('alice@example.test');
  });

  it('transport rejeté (statut HTTP) : le kind + statusCode sont tracés, pas la réponse', async () => {
    const rejecting = makeMailer(() => ({ ok: false, failure: { kind: 'rejected', statusCode: 503 } }));
    const service = createContactService({
      requests: makeRequestsRepo(),
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer: rejecting,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    const row = await service.getRequest(outcome.request.id);
    expect(row?.notificationFailure).toEqual({ kind: 'rejected', statusCode: 503 });
  });

  it('relance admin après incident : compteur remis à zéro, envoi réussi', async () => {
    let failing = true;
    const flaky = makeMailer(() =>
      failing ? { ok: false, failure: { kind: 'unreachable' } } : { ok: true, messageId: 'ok' },
    );
    const requests = makeRequestsRepo();
    const audit = makeAudit();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit,
      mailer: flaky,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    const failed = await service.getRequest(outcome.request.id);
    expect(failed?.notificationStatus).toBe('failed');

    failing = false;
    const retry = await service.retryNotification({
      requestId: outcome.request.id,
      form: demoForm,
      actorAdminId: 'admin-1',
    });
    expect(retry).toEqual({ status: 'sent' });
    const sent = await service.getRequest(outcome.request.id);
    expect(sent?.notificationStatus).toBe('sent');
    expect(sent?.notifiedAt).toBeTruthy();
    expect(audit.events.map((event) => event.action)).toEqual([
      'contact.submitted',
      'contact.notification_failed',
      'contact.notification_retried',
    ]);
  });

  it('relance sur une notification déjà envoyée : refusée (pas de double envoi)', async () => {
    const { service } = buildService();
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    const retry = await service.retryNotification({
      requestId: outcome.request.id,
      form: demoForm,
      actorAdminId: 'admin-1',
    });
    expect(retry).toBeNull();
  });

  it('relance sans transport configuré : null explicite', async () => {
    const { service } = buildService({ mailer: null, mailFrom: null });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    const retry = await service.retryNotification({
      requestId: outcome.request.id,
      form: demoForm,
      actorAdminId: 'admin-1',
    });
    expect(retry).toBeNull();
  });
});

describe('balayage de rattrapage (recovery)', () => {
  it('reprend les notifications dues, une seule fois par tentative', async () => {
    let failing = true;
    const flaky = makeMailer(() =>
      failing ? { ok: false, failure: { kind: 'unreachable' } } : { ok: true, messageId: 'ok' },
    );
    const requests = makeRequestsRepo();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer: flaky,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
      forms: { findById: (key) => (key === demoForm.key ? demoForm : null) },
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;

    // Échec initial → prochaine tentative dans 2 min. Pas encore due.
    const tooEarly = await service.runNotificationRecovery({
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(tooEarly.sent).toBe(0);

    // Due → reprise réussie.
    failing = false;
    const recovery = await service.runNotificationRecovery({
      now: new Date(NOW.getTime() + 3 * 60 * 1000),
    });
    expect(recovery.sent).toBe(1);
    const row = await service.getRequest(outcome.request.id);
    expect(row?.notificationStatus).toBe('sent');
  });

  it('promote les demandes not_configured quand un transport devient disponible', async () => {
    const { service, requests } = buildService({ mailer: null, mailFrom: null });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;

    // Le transport arrive (nouveau runtime, même base) : le service suivant
    // a un mailer ; la demande héritée doit repartir en pending puis sent.
    const mailer = makeMailer(() => ({ ok: true, messageId: 'late' }));
    const withMailer = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
      forms: { findById: (key) => (key === demoForm.key ? demoForm : null) },
    });
    const recovery = await withMailer.runNotificationRecovery({ now: NOW });
    expect(recovery.promoted).toBe(1);
    expect(recovery.sent).toBe(1);
    const row = await service.getRequest(outcome.request.id);
    expect(row?.notificationStatus).toBe('sent');
  });

  it('formulaire retiré du code : demande laissée intacte (skipped), jamais écrasée', async () => {
    const failingMailer = makeMailer(() => ({ ok: true, messageId: 'x' }));
    const requests = makeRequestsRepo();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer: failingMailer,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
      forms: { findById: () => null }, // formulaire inconnu du registre
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    await requests.markNotificationFailed(outcome.request.id, {
      failure: { kind: 'unreachable' },
      nextAttemptAt: NOW,
    });
    const recovery = await service.runNotificationRecovery({ now: NOW });
    expect(recovery.skipped).toBe(1);
    const row = await service.getRequest(outcome.request.id);
    expect(row?.payload).toEqual(validInput.values);
  });
});

describe('état éditorial et concurrence', () => {
  it('markStatus new ⇄ handled auditée au nom de l’admin', async () => {
    const { service, audit } = buildService();
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    await service.markStatus({ requestId: outcome.request.id, status: 'handled', actorAdminId: 'admin-1' });
    expect((await service.getRequest(outcome.request.id))?.status).toBe('handled');
    await service.markStatus({ requestId: outcome.request.id, status: 'new', actorAdminId: 'admin-1' });
    expect((await service.getRequest(outcome.request.id))?.status).toBe('new');
    const statusEvents = audit.events.filter((event) => event.action === 'contact.status_changed');
    expect(statusEvents).toHaveLength(2);
    expect(statusEvents[0]!.actorAdminId).toBe('admin-1');
  });

  it('claim conditionnel : deux tentatives concurrentes n’envoient qu’une fois', async () => {
    let calls = 0;
    const counting = makeMailer(() => {
      calls += 1;
      return { ok: true, messageId: 'once' };
    });
    const requests = makeRequestsRepo();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer: counting,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    // La soumission a déjà envoyé (calls = 1). Un second chemin relance la
    // même tentative (même expectedAttempts) : le claim échoue → 0 envoi.
    const retrySameAttempt = await service.retryNotification({
      requestId: outcome.request.id,
      form: demoForm,
      actorAdminId: 'admin-1',
    });
    expect(retrySameAttempt).toBeNull(); // statut sent → refus
    expect(calls).toBe(1);

    // Deux claims concurrents sur une ligne failed : un seul gagne.
    await requests.markNotificationFailed(outcome.request.id, {
      failure: { kind: 'unreachable' },
      nextAttemptAt: NOW,
    });
    const row = await service.getRequest(outcome.request.id);
    const attemptsBefore = row!.notificationAttempts;
    const [winner, loser] = await Promise.all([
      requests.claimNotificationAttempt(outcome.request.id, { expectedAttempts: attemptsBefore }),
      requests.claimNotificationAttempt(outcome.request.id, { expectedAttempts: attemptsBefore }),
    ]);
    expect(winner).not.toBeNull();
    expect(loser).toBeNull();
  });

  it('échecs répétés : plafond d’attempts atteint → échec terminal, plus de reprise auto', async () => {
    const failing = makeMailer(() => ({ ok: false, failure: { kind: 'unreachable' } }));
    const requests = makeRequestsRepo();
    const service = createContactService({
      requests,
      rateLimits: makeRateLimitsRepo(),
      audit: makeAudit(),
      mailer: failing,
      mailFrom: { email: 'no-reply@example.test' },
      secret: SECRET,
      forms: { findById: (key) => (key === demoForm.key ? demoForm : null) },
    });
    const outcome = await service.submit(validInput);
    if (outcome.kind !== 'submitted') return;
    // Simule les reprises automatiques successives jusqu'au plafond — le
    // temps avance au-delà de chaque fenêtre de backoff (2 min → 10 min →
    // 1 h → 6 h).
    let recoveryNow = new Date('2026-09-17T00:00:00Z');
    for (let attempt = 1; attempt <= CONTACT_NOTIFICATION_MAX_ATTEMPTS + 1; attempt += 1) {
      const before = await service.runNotificationRecovery({ now: recoveryNow });
      if (before.sent === 0 && before.failed === 0) break;
      recoveryNow = new Date(recoveryNow.getTime() + 7 * 60 * 60 * 1000);
    }
    const row = await service.getRequest(outcome.request.id);
    expect(row?.notificationAttempts).toBe(CONTACT_NOTIFICATION_MAX_ATTEMPTS);
    expect(row?.notificationNextAttemptAt).toBeNull(); // terminal
    const after = await service.runNotificationRecovery({
      now: new Date(recoveryNow.getTime() + 30 * 24 * 60 * 60 * 1000),
    });
    expect(after.sent).toBe(0);
    expect(after.failed).toBe(0);
  });
});
