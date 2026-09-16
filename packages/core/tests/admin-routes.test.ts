import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as adminRoutes from '../src/http/admin-routes';
import {
  ADMIN_HOME_PATH,
  ADMIN_ANALYTICS_PATH,
  ADMIN_ROUTE_PATTERNS,
  ADMIN_ROUTE_PREFIX,
  PUBLIC_ANALYTICS_BEACON_PATTERN,
  PUBLIC_ANALYTICS_EVENT_PATTERN,
  PUBLIC_FORM_SUBMIT_PATTERN,
  PUBLIC_ROUTE_PATTERNS,
} from '../src/http/admin-routes';
import {
  adminSessionCookieOptions,
  adminSessionCookieClearOptions,
  ADMIN_COOKIE_PATH,
  ADMIN_SESSION_COOKIE_NAME,
} from '../src/http/cookies';

/**
 * Garde mécanique de l'invariant **cookie `Path=/admin` ⇔ routes
 * authentifiées sous `/admin/*`** (revue slice 2, étendu au slice 3).
 *
 * Le cookie de session n'est émis qu'avec `Path=/admin` : le navigateur ne
 * l'envoie jamais avec les requêtes du site public. Ce bénéfice impose que
 * toute route consommant la session admin vive sous le préfixe `/admin`.
 * Ce test échoue si :
 * - une route admin injectée par l'intégration sort du préfixe (ex.
 *   `/api/kreiz/admin/...`) — c'est le cas d'usage qui ferait passer
 *   accidentellement le cookie à `Path=/` ;
 * - le chemin du cookie s'écarte du préfixe.
 *
 * Depuis le slice 3, **aucune route ADMIN injectée n'est publique** : la
 * route spike `/api/kreiz/spike` (slice 0) a été supprimée — le test
 * l'interdit explicitement. Les routes **publiques** injectées (soumission
 * des formulaires slice 7, collecte et beacon analytics slice 8) sont
 * listées dans `PUBLIC_ROUTE_PATTERNS`, gardées hors du préfixe, sans
 * session admin.
 */

describe('invariant namespace admin — routes authentifiées sous /admin/*', () => {
  const integrationSource = readFileSync(
    fileURLToPath(new URL('../src/integration.ts', import.meta.url)),
    'utf8',
  );

  it('le préfixe admin est exactement /admin', () => {
    expect(ADMIN_ROUTE_PREFIX).toBe('/admin');
    expect(ADMIN_ROUTE_PREFIX).not.toBe('/');
    expect(ADMIN_ROUTE_PREFIX).not.toContain('//');
  });

  it('les routes authentifiées du Core vivent toutes sous le préfixe /admin', () => {
    expect(ADMIN_ROUTE_PATTERNS.length).toBeGreaterThanOrEqual(9); // slice 2 + slice 3
    for (const pattern of ADMIN_ROUTE_PATTERNS) {
      // Le shell est le préfixe exact ; les autres routes sont sous /admin/…
      expect(
        pattern === ADMIN_ROUTE_PREFIX || pattern.startsWith(`${ADMIN_ROUTE_PREFIX}/`),
        pattern,
      ).toBe(true);
    }
    // Le shell lui-même est le préfixe exact.
    expect(ADMIN_HOME_PATH).toBe(ADMIN_ROUTE_PREFIX);
  });

  it('chaque pattern admin injecté par l’intégration est une constante du namespace admin', () => {
    const identifiers = [
      ...integrationSource.matchAll(/pattern:\s*([A-Za-z_][A-Za-z0-9_]*|'[^']+')/g),
    ].map((match) => match[1]!);
    // Toute route injectée (admin + publique) passe par une constante
    // déclarée dans admin-routes.ts — jamais de littéral ni de constante
    // locale.
    expect(identifiers.length).toBe(
      ADMIN_ROUTE_PATTERNS.length + PUBLIC_ROUTE_PATTERNS.length,
    );
    const allPatterns = [...ADMIN_ROUTE_PATTERNS, ...PUBLIC_ROUTE_PATTERNS];
    for (const identifier of identifiers) {
      expect(adminRoutes, `route injectée hors admin-routes.ts : ${identifier}`).toHaveProperty(
        identifier,
      );
      const value = (adminRoutes as Record<string, unknown>)[identifier];
      expect(typeof value, `constante inattendue : ${identifier}`).toBe('string');
      // La valeur injectée est exactement un pattern gardé de la liste.
      expect(allPatterns, `pattern non gardé : ${identifier}`).toContain(value);
    }
    for (const value of ADMIN_ROUTE_PATTERNS) {
      expect(value, `route admin hors namespace : ${value}`).toMatch(/^\/admin(\/|$)/);
    }
  });

  it('la route publique des formulaires (slice 7) est hors /admin et explicitement gardée', () => {
    // Le endpoint de soumission est hors du préfixe admin (invariant du
    // cookie Path=/admin) et listé dans PUBLIC_ROUTE_PATTERNS pour rester
    // sous garde mécanique.
    expect(PUBLIC_ROUTE_PATTERNS).toContain(PUBLIC_FORM_SUBMIT_PATTERN);
    expect(PUBLIC_FORM_SUBMIT_PATTERN.startsWith(`${ADMIN_ROUTE_PREFIX}/`)).toBe(false);
    expect(PUBLIC_FORM_SUBMIT_PATTERN).toMatch(/^\/api\//);
    for (const value of PUBLIC_ROUTE_PATTERNS) {
      expect(value, `route publique sous /admin : ${value}`).not.toMatch(/^\/admin(\/|$)/);
    }
  });

  it('les routes publiques analytics (slice 8) sont hors /admin et explicitement gardées', () => {
    // Collecte (POST JSON borné) et beacon (fichier prérendu) : routes
    // publiques sous /api, listées dans PUBLIC_ROUTE_PATTERNS, sans session
    // admin — même invariant que la soumission de formulaire.
    expect(PUBLIC_ROUTE_PATTERNS).toContain(PUBLIC_ANALYTICS_EVENT_PATTERN);
    expect(PUBLIC_ROUTE_PATTERNS).toContain(PUBLIC_ANALYTICS_BEACON_PATTERN);
    expect(PUBLIC_ANALYTICS_EVENT_PATTERN).toMatch(/^\/api\//);
    expect(PUBLIC_ANALYTICS_BEACON_PATTERN).toMatch(/^\/api\//);
    // La page admin analytics, elle, vit sous le préfixe (session requise).
    expect(ADMIN_ANALYTICS_PATH).toMatch(/^\/admin(\/|$)/);
    expect(ADMIN_ROUTE_PATTERNS).toContain(ADMIN_ANALYTICS_PATH);
  });

  it('la route spike du slice 0 est supprimée — plus aucune route injectée hors /admin', () => {
    // Le pattern exact ne doit plus exister nulle part (mention historique
    // dans un commentaire admise, route interdite).
    expect(integrationSource).not.toContain('/api/kreiz/spike');
    expect(existsSyncSpikeRoute()).toBe(false);
  });

  it('l’intégration n’injecte aucune route admin en dur hors constantes', () => {
    // Toute modification future doit passer par admin-routes.ts pour rester
    // sous la garde du test précédent.
    expect(integrationSource).toContain("from './http/admin-routes.js'");
  });

  it('le cookie de session conserve Path = préfixe admin (jamais /)', () => {
    expect(ADMIN_SESSION_COOKIE_NAME).toBe('kreiz_admin_session');
    expect(ADMIN_COOKIE_PATH).toBe(ADMIN_ROUTE_PREFIX);

    const set = adminSessionCookieOptions({ maxAgeSeconds: 3600, secure: true });
    expect(set.path).toBe('/admin');
    expect(set.path).not.toBe('/');

    const clear = adminSessionCookieClearOptions(true);
    expect(clear.path).toBe('/admin');
    expect(clear.path).not.toBe('/');
  });
});

function existsSyncSpikeRoute(): boolean {
  try {
    return existsSync(fileURLToPath(new URL('../src/routes', import.meta.url)));
  } catch {
    return false;
  }
}
