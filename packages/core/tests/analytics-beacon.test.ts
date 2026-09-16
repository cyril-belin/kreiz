import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_BEACON_PATH,
  ANALYTICS_COLLECT_PATH,
  analyticsBeaconScript,
  analyticsCtaAttributes,
  beaconModuleSource,
} from '../src/analytics/index';

/**
 * Beacon analytics (slice 8) — fichier minuscule, zéro dépendance, zéro
 * domaine tiers ; le poids est une exigence de mission (§37 : « Mesurer
 * précisément son poids », « JS minuscule »).
 */

describe('beaconModuleSource — contenu', () => {
  it('activé : un IIFE autonome avec les garde-fous de vie privée et le transport silencieux', () => {
    const source = beaconModuleSource(true);
    // Signaux de vie privée (conservateur : pas de requête du tout).
    expect(source).toContain('navigator.doNotTrack');
    expect(source).toContain('navigator.globalPrivacyControl');
    // Session éphémère sessionStorage — jamais un cookie, jamais localStorage.
    expect(source).toContain('sessionStorage');
    expect(source).not.toContain('document.cookie');
    expect(source).not.toContain('localStorage');
    // Prerender : mesure à l'activation, pas au crawl.
    expect(source).toContain('document.prerendering');
    expect(source).toContain('prerenderingchange');
    // Transport : sendBeacon + repli fetch keepalive, erreurs avalées.
    expect(source).toContain('sendBeacon');
    expect(source).toContain('keepalive');
    // Capteur muet : aucune logique de filtrage bot côté client — le
    // filtrage (UA, préfetch, chemins) appartient au serveur.
    expect(source).not.toContain('webdriver');
    // Le chemin de collecte pointe le même domaine (aucun tiers).
    expect(source).toContain(ANALYTICS_COLLECT_PATH);
    expect(source).not.toMatch(/https?:\/\//); // aucune URL absolue embarquée
  });

  it('désactivé : stub vide — le tag résiduel ne mesure rien', () => {
    const stub = beaconModuleSource(false);
    expect(stub).not.toContain('sendBeacon');
    expect(stub).not.toContain('sessionStorage');
    expect(stub.length).toBeLessThan(200);
  });
});

describe('beaconModuleSource — poids (mission §37)', () => {
  it('source < 2 Ko brute (≈ 1 Ko compressé gzip)', () => {
    const bytes = new TextEncoder().encode(beaconModuleSource(true)).length;
    expect(bytes).toBeGreaterThan(500); // réel, pas un stub accidentel
    expect(bytes).toBeLessThan(2048);
  });
});

describe('helpers publics', () => {
  it('le tag du beacon pointe le fichier local en defer', () => {
    const tag = analyticsBeaconScript();
    expect(tag).toContain(`src="${ANALYTICS_BEACON_PATH}"`);
    expect(tag).toContain('defer');
    expect(ANALYTICS_BEACON_PATH).toBe('/api/analytics/beacon.js');
    expect(ANALYTICS_COLLECT_PATH).toBe('/api/analytics/event');
  });

  it('attributs CTA : data-kz-cta typé et borné', () => {
    expect(analyticsCtaAttributes('hero-demo')).toEqual({ 'data-kz-cta': 'hero-demo' });
    const value = analyticsCtaAttributes('x'.repeat(200))['data-kz-cta'] ?? '';
    expect(value.length).toBeLessThanOrEqual(64);
  });
});
