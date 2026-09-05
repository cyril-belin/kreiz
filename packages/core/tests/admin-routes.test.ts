import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_LOGOUT_PATH,
  ADMIN_ROUTE_PREFIX,
  ADMIN_ROUTE_PATTERNS,
} from '../src/http/admin-routes';
import {
  adminSessionCookieOptions,
  adminSessionCookieClearOptions,
  ADMIN_COOKIE_PATH,
  ADMIN_SESSION_COOKIE_NAME,
} from '../src/http/cookies';

/**
 * Garde mécanique de l'invariant **cookie `Path=/admin` ⇔ routes authentifiées
 * sous `/admin/*`** (revue slice 2).
 *
 * Le cookie de session n'est émis qu'avec `Path=/admin` : le navigateur ne
 * l'envoie jamais avec les requêtes du site public. Ce bénéfice impose que
 * toute route consommant la session admin vive sous le préfixe `/admin`.
 * Ce test échoue si :
 * - une route admin injectée par l'intégration sort du préfixe (ex.
 *   `/api/kreiz/admin/...`) — c'est le cas d'usage qui ferait passer
 *   accidentellement le cookie à `Path=/` ;
 * - le chemin du cookie s'écarte du préfixe.
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
    expect(ADMIN_ROUTE_PATTERNS).toEqual([ADMIN_HOME_PATH, ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH]);
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

  it('chaque route injectée par l’intégration est la spike publique ou vit sous /admin', () => {
    const patterns = [...integrationSource.matchAll(/pattern:\s*([A-Za-z_]+|'[^']+')/g)].map(
      (match) => match[1]!,
    );
    expect(patterns.length).toBeGreaterThanOrEqual(4); // spike + 3 routes admin
    for (const pattern of patterns) {
      const value = pattern.startsWith("'") ? pattern.slice(1, -1) : pattern;
      if (value === '/api/kreiz/spike') continue; // route spike publique, sans session
      // Soit une constante du namespace admin, soit un littéral sous le préfixe.
      const resolved = value === 'ADMIN_LOGIN_PATH' || value === 'ADMIN_LOGOUT_PATH' || value === 'ADMIN_HOME_PATH'
        ? { ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH, ADMIN_HOME_PATH }[value]
        : value;
      expect(resolved, `route injectée hors namespace admin : ${value}`).toMatch(
        /^\/admin(\/|$)/,
      );
    }
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
