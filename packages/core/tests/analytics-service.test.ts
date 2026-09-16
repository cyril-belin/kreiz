import { describe, expect, it } from 'vitest';
import { resolveAnalyticsConfig } from '../src/domain/analytics/config';
import type { KreizAnalyticsConfig } from '../src/domain/analytics/config';
import { createAnalyticsService, type AnalyticsServiceDeps } from '../src/services/analytics';
import type { KreizAnalyticsEventInsert } from '../src/data/tables/analytics-events';

/**
 * Service analytics (slice 8) — orchestration en mémoire (fakes, aucun SQL)
 * : politique de collecte (désactivation, vie privée, bots, préfetch,
 * chemins exclus), rate limiting, déduplication, conversions serveur
 * (échec avalé), purge par rétention et forme du dashboard.
 */

const SESSION = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';

interface FakeRow extends KreizAnalyticsEventInsert {
  id: string;
}

function fakeDeps(options: { config?: Partial<KreizAnalyticsConfig>; rateLimitMax?: number } = {}) {
  const rows: FakeRow[] = [];
  let purged = 0;
  const windows = new Map<string, { startedAt: number; count: number }>();
  const WINDOW_MS = 60_000;
  let contentLookups = 0;
  const events = {
    async insertOrIgnore(row: KreizAnalyticsEventInsert): Promise<boolean> {
      if (row.dedupKey && rows.some((existing) => existing.dedupKey === row.dedupKey)) {
        return false;
      }
      rows.push({ ...row, id: `row-${rows.length + 1}` });
      return true;
    },
    async findPublishedContentByPath(namespace: string, slug: string) {
      contentLookups += 1;
      return namespace === 'articles' && slug === 'mon-slug'
        ? { contentEntryId: 'entry-1', contentType: 'article' }
        : null;
    },
    async purgeOlderThan(before: Date): Promise<number> {
      purged = rows.filter((row) => (row.createdAt ?? new Date()).getTime() < before.getTime()).length;
      return purged;
    },
    totals: async () => ({ pageviews: rows.length, sessions: 1, ctaClicks: 0, conversions: 0 }),
    dailySeries: async () => [],
    topPages: async () => [],
    topReferrers: async () => [],
    topCampaigns: async () => [],
    formConversions: async () => [],
  };
  const rateLimits = {
    async incrementWindowed(key: string, options: { windowMs: number; now: Date }) {
      const now = options.now.getTime();
      const existing = windows.get(key);
      if (!existing || now - existing.startedAt >= WINDOW_MS) {
        windows.set(key, { startedAt: now, count: 1 });
        return { key, windowStartedAt: new Date(now), count: 1 };
      }
      existing.count += 1;
      return { key, windowStartedAt: new Date(existing.startedAt), count: existing.count };
    },
  };
  const auditCalls: Array<{ name: string; formKey: string; page: string | null }> = [];
  const deps: AnalyticsServiceDeps & { rows: FakeRow[] } = {
    events: events as unknown as AnalyticsServiceDeps['events'],
    rateLimits: rateLimits as unknown as AnalyticsServiceDeps['rateLimits'],
    config: resolveAnalyticsConfig(options.config ?? {}),
    secret: 'secret-de-test-assez-long-pour-hmac-1234',
    rows,
  };
  const service = createAnalyticsService(deps);
  const collect = (payload: unknown, overrides: Record<string, unknown> = {}) =>
    service.collectBeacon({
      payload,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/121',
      clientIp: '203.0.113.10',
      privacySignal: false,
      prefetch: false,
      requestHost: 'site.example',
      ...(overrides as object),
    });
  return { service, deps, rows, collect, getCount: () => contentLookups, purged: () => purged, auditCalls };
}

describe('politique de collecte — décision serveur', () => {
  it('analytics désactivés : aucun compteur, aucune insertion, aucune lecture', async () => {
    const { service, rows, collect } = fakeDeps({ config: { enabled: false } });
    const outcome = await collect({ type: 'pv', path: '/' });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'disabled' });
    expect(rows).toHaveLength(0);
    await expect(service.runRetention()).resolves.toBeNull();
  });

  it('DNT/GPC : signal explicite ⇒ aucune collecte (respectPrivacySignals par défaut)', async () => {
    const { rows, collect } = fakeDeps({});
    const outcome = await collect({ type: 'pv', path: '/' }, { privacySignal: true });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'privacy-signal' });
    expect(rows).toHaveLength(0);
  });

  it('respectPrivacySignals: false → le signal DNT/GPC ne bloque plus la collecte', async () => {
    const { rows, collect } = fakeDeps({ config: { respectPrivacySignals: false } });
    const outcome = await collect({ type: 'pv', path: '/' }, { privacySignal: true });
    expect(outcome.kind).toBe('stored');
    expect(rows).toHaveLength(1);
  });

  it('préfetch et bots : ignorés (204 côté route), jamais stockés', async () => {
    const { rows, collect } = fakeDeps({});
    expect(await collect({ type: 'pv', path: '/' }, { prefetch: true })).toEqual({
      kind: 'ignored',
      reason: 'prefetch',
    });
    expect(await collect({ type: 'pv', path: '/' }, { userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0)' })).toEqual({
      kind: 'ignored',
      reason: 'bot',
    });
    expect(rows).toHaveLength(0);
  });

  it('payload non conforme : rejet schema — jamais d’insertion ni d’exception', async () => {
    const { rows, collect } = fakeDeps({});
    expect((await collect('n’importe quoi')).kind).toBe('rejected');
    expect((await collect({ type: 'pv', path: 'pas-un-chemin' })).kind).toBe('rejected');
    expect((await collect({ type: 'form_accepted', path: '/', form: 'contact' })).kind).toBe('rejected');
    expect(rows).toHaveLength(0);
  });

  it('chemins exclus (/admin, /api, extra) : acceptés côté HTTP, jamais stockés', async () => {
    const { rows, collect } = fakeDeps({ config: { excludedPaths: ['/interne'] } });
    for (const path of ['/admin', '/admin/preview/abc', '/api/forms/contact', '/interne/secret', '/favicon.ico']) {
      const outcome = await collect({ type: 'pv', path });
      expect(outcome).toEqual({ kind: 'ignored', reason: 'excluded-path' });
    }
    expect(rows).toHaveLength(0);
  });
});

describe('collecte — page views, événements, déduplication', () => {
  it('page view complet : UTM normalisés, session, device class, contenu résolu', async () => {
    const { rows, collect } = fakeDeps({});
    const outcome = await collect({
      type: 'pv',
      path: '/articles/mon-slug?utm_source=Newsletter&utm_medium=email',
      ref: 'https://google.com/search?q=x',
      session: SESSION,
      utm: { source: 'NewsLetter', medium: 'email', campaign: 'Launch' },
      locale: 'fr-FR',
    });
    expect(outcome.kind).toBe('stored');
    const row = rows[0]!;
    expect(row.eventName).toBe('page_view');
    expect(row.path).toBe('/articles/mon-slug'); // query stripping
    expect(row.utmSource).toBe('newsletter'); // minuscules
    expect(row.referrer).toBe('google.com'); // domaine seul
    expect(row.referrerKind).toBe('external');
    expect(row.sessionId).toBe(SESSION);
    expect(row.deviceClass).toBe('desktop');
    expect(row.locale).toBe('fr-fr');
    expect(row.contentEntryId).toBe('entry-1');
    expect(row.contentType).toBe('article');
    expect(row.dedupKey).toContain(SESSION);
  });

  it('page vue hors contenu (accueil) : pas de résolution, metadata vide', async () => {
    const { rows, collect } = fakeDeps({});
    await collect({ type: 'pv', path: '/', session: SESSION });
    const row = rows[0]!;
    expect(row.contentEntryId).toBeUndefined();
    expect(row.contentType).toBeUndefined();
    expect(row.metadata).toEqual({});
  });

  it('cta_click : identifiant borné dans metadata serveur', async () => {
    const { rows, collect } = fakeDeps({});
    await collect({ type: 'cta', path: '/', session: SESSION, id: 'hero-demo' });
    expect(rows[0]!.eventName).toBe('cta_click');
    expect(rows[0]!.metadata).toEqual({ cta: 'hero-demo' });
  });

  it('double beacon / retry réseau dans la même tranche : une seule ligne', async () => {
    const { rows, collect } = fakeDeps({});
    const payload = { type: 'pv', path: '/', session: SESSION };
    const now = { now: new Date('2026-09-16T12:00:10.000Z') };
    expect((await collect(payload, now)).kind).toBe('stored');
    expect((await collect(payload, now)).kind).toBe('duplicate'); // double beacon
    expect((await collect(payload, now)).kind).toBe('duplicate'); // retry
    expect(rows).toHaveLength(1);
  });

  it('rechargement au-delà de la tranche de 30 s : légitimement recompté', async () => {
    const { rows, collect } = fakeDeps({});
    const payload = { type: 'pv', path: '/', session: SESSION };
    expect((await collect(payload, { now: new Date('2026-09-16T12:00:00.000Z') })).kind).toBe('stored');
    expect((await collect(payload, { now: new Date('2026-09-16T12:00:31.000Z') })).kind).toBe('stored');
    expect(rows).toHaveLength(2);
  });

  it('rate limiting : au-delà du plafond par fenêtre, rejet avec Retry-After', async () => {
    const harness = fakeDeps({});
    const base = { userAgent: 'UA', privacySignal: false, prefetch: false, requestHost: 'site.example', clientIp: '198.51.100.7' };
    // Plafond atteint : 30 événements acceptés (chemins distincts pour des
    // clés de dédup distinctes), le 31e est rejeté.
    for (let i = 0; i < 30; i += 1) {
      const outcome = await harness.service.collectBeacon({
        ...base,
        payload: { type: 'pv', path: `/page-${i}`, session: SESSION },
      });
      expect(outcome.kind).toBe('stored');
    }
    const rejected = await harness.service.collectBeacon({
      ...base,
      payload: { type: 'pv', path: '/page-debordement', session: SESSION },
    });
    expect(rejected).toEqual({ kind: 'rejected', reason: 'rate-limited', retryAfterSeconds: expect.any(Number) });
    if (rejected.kind === 'rejected' && rejected.reason === 'rate-limited') {
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    // Aucun événement supplémentaire stocké après le plafond.
    expect(harness.rows).toHaveLength(30);
  });

  it('IP distinctes : compteurs indépendants', async () => {
    const harness = fakeDeps();
    const base = { userAgent: 'UA', privacySignal: false, prefetch: false, requestHost: 'site.example' };
    for (let i = 0; i < 3; i += 1) {
      const outcome = await harness.service.collectBeacon({
        ...base,
        payload: { type: 'pv', path: '/', session: `${SESSION.slice(0, -1)}${i}` },
        clientIp: `10.0.0.${i}`,
      });
      expect(outcome.kind).toBe('stored');
    }
    expect(harness.rows).toHaveLength(3);
  });
});

describe('conversions serveur et purge', () => {
  it('recordConversion : stocke form_accepted avec metadata.form, sans donnée visiteur', async () => {
    const { rows, service } = fakeDeps({});
    const stored = await service.recordConversion({ name: 'form_accepted', formKey: 'contact', page: '/contact', now: new Date(0) });
    expect(stored).toBe(true);
    const row = rows[0]!;
    expect(row.eventName).toBe('form_accepted');
    expect(row.metadata).toEqual({ form: 'contact' });
    expect(row.path).toBe('/contact');
    expect(Object.keys(row.metadata as Record<string, unknown>)).toEqual(['form']);
  });

  it('recordConversion : un échec SQL est avalé (la mesure ne casse jamais le contact)', async () => {
    const harness = fakeDeps({});
    harness.deps.events.insertOrIgnore = async () => {
      throw new Error('panne réseau');
    };
    const stored = await harness.service.recordConversion({ name: 'form_accepted', formKey: 'contact', page: null });
    expect(stored).toBe(false);
  });

  it('runRetention : purge bornée par la rétention configurée', async () => {
    const { service, purged } = fakeDeps({ config: { retentionDays: 7 } });
    const outcome = await service.runRetention({ now: new Date('2026-09-16T00:00:00.000Z') });
    expect(outcome).toEqual({ deleted: 0 });
    expect(purged()).toBe(0);
  });

  it('dashboard : période invalide refusée, période valide renvoyée', async () => {
    const { service } = fakeDeps({});
    await expect(service.dashboard({ days: 14 })).rejects.toThrow();
    const dashboard = await service.dashboard({ days: 7 });
    expect(dashboard.periodDays).toBe(7);
    expect(dashboard.since.getTime()).toBeLessThan(Date.now());
    expect(dashboard.topPages).toEqual([]);
  });
});
