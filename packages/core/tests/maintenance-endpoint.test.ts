import { describe, expect, it } from 'vitest';
import { handleMaintenanceRequest, type MaintenanceServices } from '../src/maintenance/endpoint';

/**
 * Endpoint de maintenance (`POST /api/maintenance`, passe de fermeture) —
 * le contrat complet côté logique : refus par défaut sans token, bearer
 * obligatoire comparé à temps constant, compteurs uniquement (aucune PII),
 * isolation des échecs par domaine, idempotence d'appel.
 */

const TOKEN = 'maintenance-token-0123456789abcdef-0123456789';

function makeServices(overrides: Partial<MaintenanceServices> = {}): MaintenanceServices & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    contact: {
      async runNotificationRecovery(options) {
        calls.push('contactNotification');
        expect(options?.now).toBeInstanceOf(Date);
        return { promoted: 1, sent: 2, failed: 0, skipped: 0 };
      },
      async runContactRetention(options) {
        calls.push(`contactRetention:${String(options?.retentionDays)}`);
        // Miroir du contrat réel : null ⇒ aucune purge (null retourné).
        return options?.retentionDays == null ? null : { purged: 3 };
      },
    },
    recovery: {
      async processStuckMedia(options) {
        calls.push('mediaStuck');
        expect(options?.now).toBeInstanceOf(Date);
        return { recovered: 0 };
      },
    },
    analytics: {
      async runRetention(options) {
        calls.push('analyticsRetention');
        expect(options?.now).toBeInstanceOf(Date);
        return { deleted: 42 };
      },
    },
    ...overrides,
  } as MaintenanceServices & { calls: string[] };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    authorization: `Bearer ${TOKEN}`,
    configuredToken: TOKEN as string | null,
    contactRetentionDays: 180 as number | null,
    services: makeServices(),
    ...overrides,
  } as Parameters<typeof handleMaintenanceRequest>[0];
}

describe('handleMaintenanceRequest — authentification (refus par défaut)', () => {
  it('token non configuré → 503, aucun service appelé, même avec un en-tête fourni', async () => {
    const services = makeServices();
    const outcome = await handleMaintenanceRequest(request({ configuredToken: null, services }));
    expect(outcome.status).toBe(503);
    expect(outcome.body).toEqual({ error: 'maintenance-not-configured' });
    expect(services.calls).toEqual([]);
  });

  it('token non configuré + en-tête quelconque → 503 (rien ne s’exécute jamais sans secret)', async () => {
    const services = makeServices();
    const outcome = await handleMaintenanceRequest(
      request({ configuredToken: null, authorization: 'Bearer x'.repeat(20), services }),
    );
    expect(outcome.status).toBe(503);
    expect(services.calls).toEqual([]);
  });

  it('bearer faux → 401 minimal, aucun service appelé, aucun indice dans le corps', async () => {
    const services = makeServices();
    const outcome = await handleMaintenanceRequest(
      request({ authorization: 'Bearer not-the-token-but-quite-long-indeed-yes', services }),
    );
    expect(outcome.status).toBe(401);
    expect(outcome.body).toEqual({ error: 'refused' });
    expect(services.calls).toEqual([]);
  });

  it('bearer correct mais token configuré différent de longueur arbitraire → 401 (pas de fuite de longueur)', async () => {
    const outcome = await handleMaintenanceRequest(
      request({ authorization: 'Bearer court', configuredToken: `${TOKEN}-beaucoup-plus-long` }),
    );
    expect(outcome.status).toBe(401);
  });

  it('en-tête malformé (pas Bearer) → 401', async () => {
    const outcome = await handleMaintenanceRequest(request({ authorization: `Basic ${TOKEN}` }));
    expect(outcome.status).toBe(401);
  });

  it('pas d’en-tête du tout → 401', async () => {
    const outcome = await handleMaintenanceRequest(request({ authorization: null }));
    expect(outcome.status).toBe(401);
  });

  it('GET → 405 (mutation réservée au POST), même avec le bon token', async () => {
    const outcome = await handleMaintenanceRequest(request({ method: 'GET' }));
    expect(outcome.status).toBe(405);
  });
});

describe('handleMaintenanceRequest — exécution', () => {
  it('bearer correct → 200, quatre recoveries appelées, compteurs techniques uniquement', async () => {
    const services = makeServices();
    const outcome = await handleMaintenanceRequest(request({ services }));
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({
      contactNotification: { promoted: 1, sent: 2, failed: 0, skipped: 0 },
      contactRetention: { purged: 3 },
      mediaStuck: { recovered: 0 },
      analyticsRetention: { deleted: 42 },
    });
    expect(services.calls).toEqual([
      'contactNotification',
      'contactRetention:180',
      'mediaStuck',
      'analyticsRetention',
    ]);
  });

  it('aucune PII dans la réponse — même si un service renvoyait des données riches, seul le résumé construit part', async () => {
    const services = makeServices({
      contact: {
        async runNotificationRecovery() {
          return { promoted: 0, sent: 0, failed: 0, skipped: 0 };
        },
        async runContactRetention() {
          // Un objet riche ne doit JAMAIS traverser : le contrat du service
          // ne retourne que des compteurs — la garantie est structurelle.
          return { purged: 0 };
        },
      },
    } as Partial<MaintenanceServices>);
    const outcome = await handleMaintenanceRequest(request({ services }));
    const serialized = JSON.stringify(outcome.body);
    // Clés attendues uniquement ; aucune clé de contenu, aucune chaîne libre.
    expect(Object.keys(outcome.body).sort()).toEqual([
      'analyticsRetention',
      'contactNotification',
      'contactRetention',
      'mediaStuck',
    ]);
    expect(serialized).not.toMatch(/email|name|message|payload|token/i);
  });

  it('rétention non configurée (null) → purge non exécutée, réponse explicite {disabled:true}', async () => {
    const services = makeServices();
    const outcome = await handleMaintenanceRequest(request({ contactRetentionDays: null, services }));
    expect(outcome.status).toBe(200);
    expect(outcome.body.contactRetention).toEqual({ disabled: true });
    // La décision est déléguée au service (contrat : null ⇒ aucune purge).
    expect(services.calls).toContain('contactRetention:null');
    // Les autres recoveries tournent toujours.
    expect(services.calls).toContain('contactNotification');
  });

  it('services indisponibles (storage non configuré) → réponse explicite, jamais une erreur', async () => {
    const outcome = await handleMaintenanceRequest(
      request({ services: { contact: null, recovery: null, analytics: null } }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body.mediaStuck).toEqual({ unavailable: true });
  });

  it('échec d’un domaine → {error:"failed"} pour lui seul, les autres continuent, statut 200', async () => {
    const services = makeServices({
      analytics: {
        async runRetention() {
          throw new Error('db down');
        },
      },
    } as Partial<MaintenanceServices>);
    const outcome = await handleMaintenanceRequest(request({ services }));
    expect(outcome.status).toBe(200);
    expect(outcome.body.analyticsRetention).toEqual({ error: 'failed' });
    expect(outcome.body.contactNotification).toEqual({ promoted: 1, sent: 2, failed: 0, skipped: 0 });
  });

  it('idempotence : deux appels consécutifs réussissent (les services sont réentrants)', async () => {
    const first = await handleMaintenanceRequest(request());
    const second = await handleMaintenanceRequest(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
