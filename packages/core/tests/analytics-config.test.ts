import { describe, expect, it } from 'vitest';
import { normalizeKreizConfig } from '../src/config';
import { resolveAnalyticsConfig } from '../src/domain/analytics/config';
import {
  ANALYTICS_RETENTION_DEFAULT_DAYS,
  ANALYTICS_RETENTION_MAX_DAYS,
  ANALYTICS_RETENTION_MIN_DAYS,
} from '../src/domain/analytics/policy';

/**
 * Configuration analytics du Project (slice 8) — validation stricte
 * (fail fast), défauts privacy-safe, bornes de rétention.
 */

describe('configuration analytics — défauts privacy-safe', () => {
  it('une config vide produit la configuration analytics résolue par défaut', () => {
    const config = normalizeKreizConfig({});
    expect(config.analytics).toEqual({
      enabled: true,
      retentionDays: ANALYTICS_RETENTION_DEFAULT_DAYS,
      respectPrivacySignals: true,
      excludedPaths: [],
      internalDomains: [],
    });
  });

  it('les valeurs déclarées sont conservées', () => {
    const config = normalizeKreizConfig({
      analytics: {
        enabled: true,
        retentionDays: 30,
        respectPrivacySignals: false,
        excludedPaths: ['/interne', '/beta'],
        internalDomains: ['www.monsite.fr'],
      },
    });
    expect(config.analytics).toEqual({
      enabled: true,
      retentionDays: 30,
      respectPrivacySignals: false,
      excludedPaths: ['/interne', '/beta'],
      internalDomains: ['www.monsite.fr'],
    });
  });

  it('resolveAnalyticsConfig tolère l’absence de section (undefined)', () => {
    expect(resolveAnalyticsConfig(undefined).enabled).toBe(true);
    expect(resolveAnalyticsConfig(null).retentionDays).toBe(ANALYTICS_RETENTION_DEFAULT_DAYS);
  });
});

describe('configuration analytics — validation stricte', () => {
  it('rejette une clé inconnue (jamais ignorée silencieusement)', () => {
    expect(() => normalizeKreizConfig({ analytics: { cookies: true } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { enabled: true, trackingId: 'UA-1' } })).toThrow();
  });

  it('rejette les rétentions invalides (bornes 7..365)', () => {
    expect(() => normalizeKreizConfig({ analytics: { retentionDays: 0 } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { retentionDays: -10 } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { retentionDays: 6 } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { retentionDays: ANALYTICS_RETENTION_MAX_DAYS + 1 } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { retentionDays: 12.5 } })).toThrow();
    expect(() =>
      normalizeKreizConfig({ analytics: { retentionDays: ANALYTICS_RETENTION_MIN_DAYS } }),
    ).not.toThrow();
  });

  it('rejette les préfixes exclus invalides', () => {
    expect(() => normalizeKreizConfig({ analytics: { excludedPaths: ['interne'] } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { excludedPaths: ['//evil.example'] } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { excludedPaths: ['/x\r\n'] } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { excludedPaths: ['/avec-slash/'] } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { excludedPaths: ['/ok-prefix'] } })).not.toThrow();
  });

  it('rejette les domaines internes invalides et borne les listes', () => {
    expect(() => normalizeKreizConfig({ analytics: { internalDomains: ['pas_un_domaine'] } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: { internalDomains: ['ok.example'] } })).not.toThrow();
    expect(() =>
      normalizeKreizConfig({ analytics: { excludedPaths: Array.from({ length: 21 }, (_, i) => `/${i}`) } }),
    ).toThrow();
  });

  it('rejette les types flagrants', () => {
    expect(() => normalizeKreizConfig({ analytics: { enabled: 'oui' } })).toThrow();
    expect(() => normalizeKreizConfig({ analytics: 'activé' })).toThrow();
  });
});
