import type { AnalyticsEventsRepository } from '../data/repositories/analytics-events.js';
import type { RateLimitsRepository } from '../data/repositories/rate-limits.js';
import type { KreizAnalyticsConfig } from '../domain/analytics/config.js';
import { parseClientEvent, type NormalizedClientEvent } from '../domain/analytics/collect.js';
import {
  ANALYTICS_RATE_LIMIT_MAX,
  ANALYTICS_RATE_LIMIT_WINDOW_MS,
  analyticsDedupKey,
  analyticsRateLimitKey,
  deviceClassFromUserAgent,
  isBotUserAgent,
  isDashboardPeriod,
  isExcludedAnalyticsPath,
  splitContentPath,
  type AnalyticsDashboardPeriod,
} from '../domain/analytics/policy.js';
import { pseudonymizeIp } from './auth-tokens.js';
import { RATE_LIMIT_PURGE_AFTER_MS } from '../domain/auth.js';

/**
 * Service analytics (slice 8) — orchestration de la collecte et du
 * dashboard. Toutes les décisions (activation, signaux de vie privée,
 * bots, préfetch, chemins exclus, rate limiting, déduplication) sont
 * **serveur** : le beacon n'est qu'un capteur.
 *
 * Le service n'échoue jamais bruyamment : un échec d'insertion d'une
 * conversion serveur (hook contact) est avalé — la mesure ne doit jamais
 * casser le produit qu'elle observe. Les événements de navigation, eux,
 * remontent leurs rejets (la route en fait des réponses muettes).
 */

export type AnalyticsCollectOutcome =
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'ignored'; reason: 'disabled' | 'privacy-signal' | 'bot' | 'prefetch' | 'excluded-path' }
  | { kind: 'rejected'; reason: 'schema' }
  | { kind: 'rejected'; reason: 'rate-limited'; retryAfterSeconds: number };

export type AnalyticsConversionEventName = 'form_accepted' | 'form_notification_sent';

export interface AnalyticsServiceDeps {
  events: AnalyticsEventsRepository;
  rateLimits: RateLimitsRepository;
  /** Configuration résolue du Project (défauts privacy-safe appliqués). */
  config: KreizAnalyticsConfig;
  /** Secret de déploiement — pseudonymisation éphémère de l'IP (rate limiting). */
  secret: string;
}

export function createAnalyticsService(deps: AnalyticsServiceDeps) {
  const { events, rateLimits, config, secret } = deps;

  /**
   * Traite un événement de navigation beacon (payload JSON déjà extrait et
   * borné en taille par la route). Retourne une issue exploitable par la
   * route — le payload n'est jamais renvoyé, quelle que soit l'issue.
   */
  async function collectBeacon(input: {
    payload: unknown;
    userAgent: string | null;
    clientIp: string | null;
    /** Signal DNT/GPC détecté sur la requête (politique config.respectPrivacySignals). */
    privacySignal: boolean;
    /** Préfetch/prerender détecté (`Sec-Purpose`, `Purpose`, `X-Moz`). */
    prefetch: boolean;
    /** Hôte de la requête — classification interne/externe du referrer. */
    requestHost: string | null;
    now?: Date;
  }): Promise<AnalyticsCollectOutcome> {
    const now = input.now ?? new Date();

    if (!config.enabled) return { kind: 'ignored', reason: 'disabled' };
    if (input.privacySignal && config.respectPrivacySignals) {
      return { kind: 'ignored', reason: 'privacy-signal' };
    }
    if (input.prefetch) return { kind: 'ignored', reason: 'prefetch' };
    if (isBotUserAgent(input.userAgent)) return { kind: 'ignored', reason: 'bot' };

    const parsed = parseClientEvent(input.payload, {
      requestHost: input.requestHost,
      internalDomains: config.internalDomains,
    });
    if (parsed.kind === 'invalid') return { kind: 'rejected', reason: 'schema' };
    const event = parsed.event;

    // Chemins exclus — accepté (204) mais jamais stocké : l'admin ne
    // devient jamais une page « populaire ».
    if (isExcludedAnalyticsPath(event.path, config.excludedPaths)) {
      return { kind: 'ignored', reason: 'excluded-path' };
    }

    // Rate limiting — compté avant tout stockage (coût des requêtes
    // hostiles inclus). L'IP n'est jamais persistée : HMAC éphémère à
    // finalité anti-abus uniquement, même dérivation que le login.
    const ipHash = pseudonymizeIp(input.clientIp ?? 'unknown', secret);
    const counter = await rateLimits.incrementWindowed(analyticsRateLimitKey(ipHash), {
      windowMs: ANALYTICS_RATE_LIMIT_WINDOW_MS,
      now,
    });
    if (counter.count > ANALYTICS_RATE_LIMIT_MAX) {
      const windowEndsAt = counter.windowStartedAt.getTime() + ANALYTICS_RATE_LIMIT_WINDOW_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAt - now.getTime()) / 1000));
      return { kind: 'rejected', reason: 'rate-limited', retryAfterSeconds };
    }

    // Performance de contenu : résolution serveur chemin → contenu publié
    // (une requête indexée, au plus, par page vue).
    const content = event.name === 'page_view' ? await resolveContent(event) : null;

    const stored = await events.insertOrIgnore({
      eventName: event.name,
      path: event.path,
      referrer: event.referrerDomain,
      referrerKind: event.referrerKind,
      sessionId: event.sessionId,
      deviceClass: deviceClassFromUserAgent(input.userAgent),
      locale: event.locale,
      utmSource: event.utm.source,
      utmMedium: event.utm.medium,
      utmCampaign: event.utm.campaign,
      utmContent: event.utm.content,
      utmTerm: event.utm.term,
      metadata: event.name === 'cta_click' && event.ctaId ? { cta: event.ctaId } : {},
      dedupKey: analyticsDedupKey({
        sessionId: event.sessionId,
        eventName: event.name,
        path: event.path,
        ctaId: event.ctaId,
        now,
      }),
      ...(content ?? {}),
      createdAt: now,
    });
    return stored ? { kind: 'stored' } : { kind: 'duplicate' };
  }

  async function resolveContent(
    event: NormalizedClientEvent,
  ): Promise<{ contentEntryId?: string; contentType?: string } | null> {
    const parts = splitContentPath(event.path);
    if (!parts) return null;
    try {
      return await events.findPublishedContentByPath(parts.namespace, parts.slug);
    } catch {
      // La résolution de contenu ne doit jamais faire perdre la page vue.
      return null;
    }
  }

  /**
   * Conversion **serveur** (hook du service contact) — jamais appelée
   * depuis l'endpoint public. Aucune donnée visiteur n'y entre : clé de
   * formulaire, page (chemin referer same-origin normalisé) et horodatage
   * seulement. Un échec est avalé : la mesure ne casse jamais le contact.
   */
  async function recordConversion(input: {
    name: AnalyticsConversionEventName;
    formKey: string;
    page: string | null;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    try {
      return await events.insertOrIgnore({
        eventName: input.name,
        path: input.page ?? '(formulaire)',
        metadata: { form: input.formKey },
        createdAt: now,
      });
    } catch {
      return false;
    }
  }

  /**
   * Purge par rétention — événements plus vieux que `config.retentionDays`.
   * Appelée opportunistiquement par la page admin analytics et disponible
   * pour un cron futur ; aucun scheduler obligatoire. Purge aussi les
   * compteurs de rate limiting échus (revue sécurité finale) : les clés
   * analytics sont créées à cardinalité contrôlée par le client (IP forgée
   * hors plateforme de confiance, rotation IPv6) — sans purge régulière, la
   * table grossit sans borne sur un site attaqué et ne bénéficiait jusque là
   * que des échecs de login admin.
   */
  async function runRetention(options: { now?: Date } = {}): Promise<{ deleted: number } | null> {
    if (!config.enabled) return null;
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await events.purgeOlderThan(cutoff);
    // Best-effort : un échec de purge des compteurs ne doit pas faire échouer
    // la purge de rétention (bornée côté repository, silencieuse ici).
    try {
      await rateLimits.purgeExpired(new Date(now.getTime() - RATE_LIMIT_PURGE_AFTER_MS));
    } catch {
      // ignoré — la prochaine exécution retentera
    }
    return { deleted };
  }

  /** Dashboard admin — agrégations SQL bornées, périodes 7/30/90 jours. */
  async function dashboard(options: { days: number; now?: Date }): Promise<AnalyticsDashboard> {
    if (!isDashboardPeriod(options.days)) {
      throw new Error(`@kreiz/core : période analytics invalide (${options.days}).`);
    }
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);
    const [totals, daily, topPages, topReferrers, topCampaigns, formConversions] = await Promise.all([
      events.totals({ since }),
      events.dailySeries({ since }),
      events.topPages({ since }),
      events.topReferrers({ since }),
      events.topCampaigns({ since }),
      events.formConversions({ since }),
    ]);
    return {
      periodDays: options.days,
      since,
      totals,
      daily: daily.map((row) => ({
        // Jour `YYYY-MM-DD` UTC déjà normalisé en SQL (aucune re-parse).
        day: row.day,
        pageviews: row.pageviews,
        sessions: row.sessions,
        conversions: row.conversions,
      })),
      topPages,
      topReferrers,
      topCampaigns: topCampaigns.map((row) => ({
        label: [row.source, row.medium, row.campaign].filter((part) => part !== null).join(' / '),
        views: row.views,
      })),
      formConversions,
      generatedAt: now,
    };
  }

  return {
    /** Configuration résolue — état affiché à l'admin (activation, rétention). */
    config,
    collectBeacon,
    recordConversion,
    runRetention,
    dashboard,
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;

export interface AnalyticsDashboard {
  periodDays: AnalyticsDashboardPeriod;
  since: Date;
  totals: { pageviews: number; sessions: number; ctaClicks: number; conversions: number };
  daily: Array<{ day: string; pageviews: number; sessions: number; conversions: number }>;
  topPages: Array<{ path: string; views: number }>;
  topReferrers: Array<{ domain: string | null; views: number }>;
  topCampaigns: Array<{ label: string; views: number }>;
  formConversions: Array<{ form: string; accepted: number }>;
  generatedAt: Date;
}
