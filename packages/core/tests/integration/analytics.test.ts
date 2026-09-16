import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveAnalyticsConfig } from '../../src/domain/analytics/config';
import { createAnalyticsEventsRepository } from '../../src/data/repositories/analytics-events';
import { createRateLimitsRepository } from '../../src/data/repositories/rate-limits';
import { createAnalyticsService } from '../../src/services/analytics';
import {
  describeIntegration,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Analytics sur PostgreSQL réel (slice 8, mission §34) : insertion page
 * view/événement, inserts concurrents, déduplication, purge, agrégations
 * 7/30/90 (buckets journaliers UTC, top pages/referrers/campagnes),
 * conversion formulaire, chemins exclus absents, résolution contenu avec
 * FK SET NULL, et **absence structurelle de PII**.
 */
const runId = crypto.randomUUID().slice(0, 8);

function serviceFor(harness: IntegrationHarness, config = resolveAnalyticsConfig({})) {
  return createAnalyticsService({
    events: createAnalyticsEventsRepository(harness.db),
    rateLimits: createRateLimitsRepository(harness.db),
    config,
    secret: 'secret-integration-analytics-0123456789',
  });
}

/**
 * Nettoyage **hermétique** : tous les runs de ce fichier marquent leurs
 * lignes par le préfixe de chemin `/it-` et la clé de formulaire `it-…` —
 * le nettoyage vise donc les lignes de TOUS les runs (un nettoyage limité
 * au run courant laisserait s'accumuler des lignes d'agrégation qui
 * feraient déborder les tops LIMIT 10 des runs suivants).
 */
async function cleanup(harness: IntegrationHarness): Promise<void> {
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_analytics_events where path like '/it-%'`),
  );
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_analytics_events where metadata->>'form' like 'it-%'`),
  );
  await withTransientNetworkRetry(() =>
    harness.raw(sql`delete from kreiz_rate_limits where key like 'analytics:%'`),
  );
}

describeIntegration('analytics repository — PostgreSQL réel', () => {
  let harness: IntegrationHarness;
  let repo: ReturnType<typeof createAnalyticsEventsRepository>;

  beforeAll(async () => {
    harness = await setupIntegration();
    repo = createAnalyticsEventsRepository(harness.db);
    await cleanup(harness);
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await cleanup(harness);
    await harness.close();
  });

  it('insert page view + lecture typée : utm, referrer réduit, session, locale, device class', async () => {
    const t = new Date('2026-09-10T08:30:00.000Z');
    const stored = await repo.insertOrIgnore({
      eventName: 'page_view',
      path: `/it-${runId}/articles/a`,
      referrer: 'google.com',
      referrerKind: 'external',
      sessionId: '11111111-1111-4111-8111-111111111111',
      deviceClass: 'desktop',
      locale: 'fr-fr',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
      metadata: {},
      createdAt: t,
    });
    expect(stored).toBe(true);
    const rows = await harness.raw(
      sql`select event_name, path, referrer, referrer_kind, session_id, device_class, locale, utm_source, created_at
          from kreiz_analytics_events where path = ${`/it-${runId}/articles/a`} limit 1`,
    );
    const row = rows.at(0)! as Record<string, unknown>;
    expect(row.event_name).toBe('page_view');
    expect(row.referrer).toBe('google.com');
    expect(row.referrer_kind).toBe('external');
    expect(row.session_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(row.locale).toBe('fr-fr');
    expect(row.utm_source).toBe('newsletter');
    expect(new Date(row.created_at as string).toISOString()).toBe(t.toISOString());
  });

  it('déduplication : même clé → une ligne ; tranche suivante → deux', async () => {
    const session = '22222222-2222-4222-8222-222222222222';
    const t0 = new Date('2026-09-10T09:00:00.000Z');
    const path = `/it-${runId}/dedup`;
    expect(
      await repo.insertOrIgnore({ eventName: 'page_view', path, sessionId: session, dedupKey: `${runId}|d1`, createdAt: t0 }),
    ).toBe(true);
    expect(
      await repo.insertOrIgnore({ eventName: 'page_view', path, sessionId: session, dedupKey: `${runId}|d1`, createdAt: t0 }),
    ).toBe(false);
    // Tranche suivante (clé différente) : légitime, stockée.
    expect(
      await repo.insertOrIgnore({
        eventName: 'page_view',
        path,
        sessionId: session,
        dedupKey: `${runId}|d2`,
        createdAt: new Date('2026-09-10T09:00:35.000Z'),
      }),
    ).toBe(true);
    const rows = await harness.raw(
      sql`select count(*)::int as count from kreiz_analytics_events where path = ${path}`,
    );
    expect(Number(rows.at(0)?.count)).toBe(2);
  });

  it('inserts concurrents : 25 événements simultanés, tous comptés, contraintes cohérentes', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        repo.insertOrIgnore({
          eventName: 'page_view',
          path: `/it-${runId}/concurrent/${i}`,
          sessionId: '33333333-3333-4333-8333-333333333333',
          dedupKey: `${runId}|concurrent|${i}`,
          createdAt: new Date('2026-09-10T10:00:00.000Z'),
        }),
      ),
    );
    expect(results.filter((stored) => stored)).toHaveLength(25);
    const rows = await harness.raw(
      sql`select count(*)::int as count from kreiz_analytics_events where path like ${`/it-${runId}/concurrent/%`}`,
    );
    expect(Number(rows.at(0)?.count)).toBe(25);
  });

  it('concurrence réelle : purge et agrégations pendant les inserts (mission §26)', async () => {
    const since = new Date('2026-09-09T00:00:00.000Z');
    const [inserts, purged, series] = await Promise.all([
      Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          repo.insertOrIgnore({
            eventName: 'page_view',
            path: `/it-${runId}/mixed/${i}`,
            dedupKey: `${runId}|mixed|${i}`,
            createdAt: new Date('2026-09-11T10:00:00.000Z'),
          }),
        ),
      ),
      repo.purgeOlderThan(since),
      repo.dailySeries({ since }),
    ]);
    // Aucune course : chaque insert est appliqué exactement une fois et les
    // lectures concurrentes ne voient jamais d'état incohérent.
    expect(inserts.filter((stored) => stored)).toHaveLength(15);
    expect(purged).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(series)).toBe(true);
    const rows = await harness.raw(
      sql`select count(*)::int as count from kreiz_analytics_events where path like ${`/it-${runId}/mixed/%`}`,
    );
    expect(Number(rows.at(0)?.count)).toBe(15);
  });

  it('purge par rétention : les anciens partent, les récents restent', async () => {
    await repo.insertOrIgnore({
      eventName: 'page_view',
      path: `/it-${runId}/purge-old`,
      dedupKey: `${runId}|purge-old`,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await repo.insertOrIgnore({
      eventName: 'page_view',
      path: `/it-${runId}/purge-new`,
      dedupKey: `${runId}|purge-new`,
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    const deleted = await repo.purgeOlderThan(new Date('2026-09-01T00:00:00.000Z'));
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await harness.raw(
      sql`select count(*)::int as count from kreiz_analytics_events where path in (${`/it-${runId}/purge-old`}, ${`/it-${runId}/purge-new`})`,
    );
    expect(Number(remaining.at(0)?.count)).toBe(1);
  });

  it('agrégations : séries journalières UTC, top pages/referrers/campagnes, conversions', async () => {
    // Domaines marqués par run : les tests du fichier partagent la base —
    // les assertions portent sur les lignes de CE run.
    const domainA = `${runId}-bing.example`;
    const domainB = `${runId}-ddg.example`;
    const mk = (
      day: string,
      path: string,
      extra: { referrerKind?: string; referrer?: string; campaign?: string; source?: string; medium?: string } = {},
    ) =>
      repo.insertOrIgnore({
        eventName: 'page_view',
        path: `/it-${runId}${path}`,
        referrerKind: extra.referrerKind ?? null,
        referrer: extra.referrer ?? null,
        utmCampaign: extra.campaign ?? null,
        utmSource: extra.source ?? null,
        utmMedium: extra.medium ?? null,
        createdAt: new Date(day),
      });
    await Promise.all([
      mk('2026-09-14T08:00:00.000Z', '/agg/a'),
      mk('2026-09-14T09:00:00.000Z', '/agg/a'),
      // domainA cumule 2 vues : l'ordre des tops à égalité de vues est
      // arbitraire en SQL — la hiérarchie testée doit être stricte.
      mk('2026-09-14T10:00:00.000Z', '/agg/b', { referrerKind: 'external', referrer: domainA }),
      mk('2026-09-14T11:00:00.000Z', '/agg/c', { referrerKind: 'external', referrer: domainA }),
      mk('2026-09-15T08:00:00.000Z', '/agg/a', {
        referrerKind: 'external',
        referrer: domainB,
        campaign: `launch-${runId}`,
        source: `news-${runId}`,
        medium: 'email',
      }),
      mk('2026-08-20T08:00:00.000Z', '/agg/hors-periode'),
    ]);

    const since7 = new Date('2026-09-16T00:00:00.000Z').getTime() - 7 * 24 * 3600 * 1000;
    const since7Date = new Date(since7);
    const daily = await repo.dailySeries({ since: since7Date });
    const days = daily.map((row) => ({ day: row.day, pageviews: row.pageviews }));
    // Jour retourné en texte `YYYY-MM-DD` explicitement UTC.
    expect(days.map((entry) => entry.day)).toContain('2026-09-14');
    expect(days.map((entry) => entry.day)).toContain('2026-09-15');
    expect(days.map((entry) => entry.day)).not.toContain('2026-08-20'); // hors période
    const day14 = days.find((entry) => entry.day === '2026-09-14');
    expect(day14?.pageviews).toBe(4);

    const totals = await repo.totals({ since: since7Date });
    expect(totals.pageviews).toBeGreaterThanOrEqual(4);
    expect(totals.sessions).toBeGreaterThanOrEqual(0);

    const topPages = await repo.topPages({ since: since7Date });
    expect(topPages.at(0)).toMatchObject({ path: `/it-${runId}/agg/a` });
    expect(topPages.at(0)?.views).toBe(3);

    const topReferrers = await repo.topReferrers({ since: since7Date, limit: 50 });
    const domains = topReferrers.map((row) => row.domain);
    expect(domains).toContain(domainA);
    expect(domains).toContain(domainB);
    // Tri par vues décroissantes stricte : 2 vues (A) avant 1 vue (B).
    expect(domains.indexOf(domainA)).toBeLessThan(domains.indexOf(domainB));
    expect(domains).not.toContain(null); // direct jamais listé

    const topCampaigns = await repo.topCampaigns({ since: since7Date });
    expect(topCampaigns.map((row) => row.campaign)).toContain(`launch-${runId}`);
    const campaign = topCampaigns.find((row) => row.campaign === `launch-${runId}`);
    expect(campaign).toMatchObject({ source: `news-${runId}`, medium: 'email' });

    // Conversions par formulaire.
    await repo.insertOrIgnore({
      eventName: 'form_accepted',
      path: '/contact',
      metadata: { form: `it-${runId}-contact` },
      createdAt: new Date('2026-09-15T12:00:00.000Z'),
    });
    const conversions = await repo.formConversions({ since: since7Date });
    expect(conversions).toContainEqual({ form: `it-${runId}-contact`, accepted: 1 });
  });

  it('agrégations 7/30/90 : le périmètre temporel change les résultats (pas la requête)', async () => {
    const now = new Date('2026-09-16T12:00:00.000Z');
    const periods = [7, 30, 90].map(async (days) => {
      const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
      const totals = await repo.totals({ since });
      return { days, pageviews: totals.pageviews };
    });
    const results = await Promise.all(periods);
    const byDays = new Map(results.map((entry) => [entry.days, entry.pageviews]));
    expect(byDays.get(90)!).toBeGreaterThanOrEqual(byDays.get(30)!);
    expect(byDays.get(30)!).toBeGreaterThanOrEqual(byDays.get(7)!);
    expect(byDays.get(7)!).toBeLessThan(byDays.get(90)!); // l'événement du 20/08 hors 7 jours
  });

  it('FK content_entry_id : SET NULL — la télémétrie survit à une purge de contenu', async () => {
    const adminId = crypto.randomUUID();
    const contentId = crypto.randomUUID();
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`insert into kreiz_admin_users (id, email, password_hash, name) values ('${adminId}', 'it-${runId}@analytics.example', 'x', 'IT')`)),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`insert into kreiz_content_entries (id, content_type, route_namespace, title, slug, status, data, created_by, updated_by) values ('${contentId}', 'article', 'articles', 'IT analytics', 'it-${runId}-analytics', 'published', '{}', '${adminId}', '${adminId}')`)),
    );
    await repo.insertOrIgnore({
      eventName: 'page_view',
      path: `/it-${runId}/fk`,
      contentEntryId: contentId,
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    await withTransientNetworkRetry(() => harness.raw(sql.raw(`delete from kreiz_content_entries where id = '${contentId}'`)));
    const rows = await harness.raw(
      sql`select content_entry_id from kreiz_analytics_events where path = ${`/it-${runId}/fk`}`,
    );
    expect(rows.at(0)?.content_entry_id).toBeNull();
    await withTransientNetworkRetry(() =>
      harness.raw(sql.raw(`delete from kreiz_admin_users where id = '${adminId}'`)),
    );
  });
});

describeIntegration('analytics service — politique sur PostgreSQL réel', () => {
  let harness: IntegrationHarness;

  beforeAll(async () => {
    harness = await setupIntegration();
    await cleanup(harness);
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    await cleanup(harness);
    await harness.close();
  });

  it('collecte beacon de bout en bout : stocké, puis chemins exclus absents', async () => {
    const service = serviceFor(harness);
    const base = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
      clientIp: '192.0.2.10',
      privacySignal: false,
      prefetch: false,
      requestHost: 'site.example',
    };
    const session = '44444444-4444-4444-8444-444444444444';
    const stored = await service.collectBeacon({
      ...base,
      payload: { type: 'pv', path: `/it-${runId}/svc`, session, utm: { source: 'Newsletter' } },
      now: new Date('2026-09-15T09:00:00.000Z'),
    });
    expect(stored.kind).toBe('stored');
    for (const path of ['/admin', '/admin/preview/x', '/api/analytics/event']) {
      const outcome = await service.collectBeacon({
        ...base,
        payload: { type: 'pv', path, session },
      });
      expect(outcome).toEqual({ kind: 'ignored', reason: 'excluded-path' });
    }
    const rows = await harness.raw(
      sql`select path, device_class, utm_source from kreiz_analytics_events
          where path like ${`/it-${runId}/svc%`} or path like '/admin%' or path like '/api%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({ device_class: 'mobile', utm_source: 'newsletter' });
  });

  it('aucune PII structurelle : la ligne ne contient ni IP, ni UA, ni query, ni donnée formulaire', async () => {
    const service = serviceFor(harness);
    const session = '55555555-5555-4555-8555-555555555555';
    await service.collectBeacon({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Test-UA-<run>',
      clientIp: '203.0.113.99',
      privacySignal: false,
      prefetch: false,
      requestHost: 'site.example',
      payload: { type: 'pv', path: `/it-${runId}/pii?token=secret-email@x&session=fp`, session },
      now: new Date('2026-09-15T10:00:00.000Z'),
    });
    const rows = await harness.raw(
      sql`select * from kreiz_analytics_events where path like ${`/it-${runId}/pii%`}`,
    );
    expect(rows).toHaveLength(1);
    const row = JSON.stringify(rows.at(0));
    expect(row).not.toContain('203.0.113.99'); // IP jamais stockée
    expect(row).not.toContain('Test-UA-<run>'); // UA brut jamais stocké
    expect(row).not.toContain('token='); // query jamais stockée
    expect(row).not.toContain('secret-email'); // query jamais stockée
    expect(rows.at(0)?.referrer).toBeNull();
    expect(rows.at(0)?.referrer_kind).toBeNull();
  });

  it('DNT/GPC : signal explicite ⇒ zéro ligne en base', async () => {
    const service = serviceFor(harness);
    const session = '66666666-6666-4666-8666-666666666666';
    const outcome = await service.collectBeacon({
      userAgent: 'Mozilla/5.0',
      clientIp: '192.0.2.50',
      privacySignal: true,
      prefetch: false,
      requestHost: 'site.example',
      payload: { type: 'pv', path: `/it-${runId}/dnt`, session },
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'privacy-signal' });
    const rows = await harness.raw(
      sql`select count(*)::int as count from kreiz_analytics_events where path = ${`/it-${runId}/dnt`}`,
    );
    expect(Number(rows.at(0)?.count)).toBe(0);
  });

  it('conversion serveur : form_accepted persisté, métadonnées réduites à la clé de formulaire', async () => {
    const service = serviceFor(harness);
    const formKey = `it-${runId}-form`;
    expect(
      await service.recordConversion({ name: 'form_accepted', formKey, page: `/it-${runId}/contact` }),
    ).toBe(true);
    const rows = await harness.raw(
      sql`select event_name, metadata, path from kreiz_analytics_events where metadata->>'form' = ${formKey}`,
    );
    const row = rows.at(0)! as Record<string, unknown>;
    expect(row.event_name).toBe('form_accepted');
    expect(row.metadata).toEqual({ form: formKey }); // aucune donnée visiteur
    expect(row.path).toBe(`/it-${runId}/contact`);
  });

  it('rétention : purge des événements plus vieux que la config', async () => {
    const service = serviceFor(harness, resolveAnalyticsConfig({ retentionDays: 30 }));
    const outcome = await service.runRetention({ now: new Date('2026-09-16T00:00:00.000Z') });
    expect(outcome).not.toBeNull();
    expect(outcome!.deleted).toBeGreaterThanOrEqual(0);
  });
});
