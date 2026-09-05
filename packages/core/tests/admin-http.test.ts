import { describe, expect, it, vi } from 'vitest';
import { processLoginSubmission } from '../src/http/admin-login';
import {
  adminSessionCookieClearOptions,
  adminSessionCookieOptions,
  ADMIN_COOKIE_PATH,
  ADMIN_SESSION_COOKIE_NAME,
} from '../src/http/cookies';
import { verifySessionCsrfToken, CSRF_FORM_FIELD } from '../src/http/csrf';
import {
  adminApiDenyStatus,
  resolveAdminAccess,
  sessionTokenFromCookies,
} from '../src/http/guards';
import { isTrustedSameSiteMutation } from '../src/http/mutations';
import { adminSecurityHeaders } from '../src/http/security-headers';
import { parseKreizAdminEnv } from '../src/http/server-env';
import { deriveSessionCsrfToken, generateSessionToken } from '../src/services/auth-tokens';
import { stubAdminUser, stubSession } from './helpers/in-memory-auth';

describe('en-têtes de sécurité /admin', () => {
  it('portent noindex, nosniff, referrer, permissions, anti-framing', () => {
    const headers = adminSecurityHeaders({ prod: true });
    expect(headers['x-robots-tag']).toContain('noindex');
    expect(headers['x-content-type-options']).toBe('nosniff');
    // no-referrer annulerait l'header Origin des POST de formulaires
    // (Chromium) — incompatible avec la validation Origin du CSRF.
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('HSTS uniquement en production', () => {
    expect(adminSecurityHeaders({ prod: true })['strict-transport-security']).toContain(
      'max-age=31536000',
    );
    expect(adminSecurityHeaders({ prod: false })['strict-transport-security']).toBeUndefined();
  });
});

describe('cookie de session admin', () => {
  it('HttpOnly, SameSite=Lax, Path=/admin, Secure paramétrable, maxAge aligné', () => {
    const options = adminSessionCookieOptions({ maxAgeSeconds: 1234.7, secure: true });
    expect(ADMIN_SESSION_COOKIE_NAME).toBe('kreiz_admin_session');
    expect(ADMIN_COOKIE_PATH).toBe('/admin');
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/admin',
      maxAge: 1235,
    });
  });

  it('invalidation : maxAge 0, mêmes attributs', () => {
    expect(adminSessionCookieClearOptions(false)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/admin',
      maxAge: 0,
    });
  });
});

describe('CSRF lié à la session', () => {
  it('valide le token dérivé de la session courante uniquement', () => {
    const token = generateSessionToken();
    const csrf = deriveSessionCsrfToken(token);
    expect(verifySessionCsrfToken(token, csrf)).toBe(true);
    expect(verifySessionCsrfToken(token, deriveSessionCsrfToken(generateSessionToken()))).toBe(false);
    expect(verifySessionCsrfToken(token, null)).toBe(false);
    expect(verifySessionCsrfToken(token, undefined)).toBe(false);
    expect(verifySessionCsrfToken(token, '')).toBe(false);
    expect(CSRF_FORM_FIELD).toBe('csrf_token');
  });
});

describe('mutations same-origin (complément CSRF)', () => {
  const url = 'https://admin.example.test/admin/logout';

  it('laisse passer une requête navigateur same-origin', () => {
    const request = new Request(url, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'https://admin.example.test' },
    });
    expect(isTrustedSameSiteMutation(request)).toBe(true);
  });

  it('refuse un Sec-Fetch-Site non same-origin', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const request = new Request(url, {
        method: 'POST',
        headers: { 'sec-fetch-site': site, origin: 'https://admin.example.test' },
      });
      expect(isTrustedSameSiteMutation(request)).toBe(false);
    }
  });

  it('refuse un Origin dont l’hôte ne correspond pas', () => {
    const request = new Request(url, {
      method: 'POST',
      headers: { origin: 'https://attaquant.example' },
    });
    expect(isTrustedSameSiteMutation(request)).toBe(false);
  });

  it('accepte un client sans headers navigateur (curl, serveur)', () => {
    expect(isTrustedSameSiteMutation(new Request(url, { method: 'POST' }))).toBe(true);
  });
});

describe('guards admin (purs, sans HTTP réel)', () => {
  const sessionToken = generateSessionToken();

  function fakeCookies(value: string | undefined) {
    return {
      get(name: string) {
        return name === ADMIN_SESSION_COOKIE_NAME && value !== undefined
          ? { value }
          : undefined;
      },
    };
  }

  // Utilitaire local : auth de test dont resolveSession est stubbé.
  function authReturning(resolution: object) {
    return { resolveSession: vi.fn(async () => resolution) };
  }

  it('aucune session → no-session, sans appel service', async () => {
    const auth = authReturning({ status: 'invalid' });
    const access = await resolveAdminAccess(auth as never, null);
    expect(access).toEqual({ kind: 'unauthenticated', reason: 'no-session' });
    expect(auth.resolveSession).not.toHaveBeenCalled();
  });

  it('session authentifiée → admin + csrf + durée de cookie restante', async () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const expiresAt = new Date(now.getTime() + 3600 * 1000);
    const auth = authReturning({
      status: 'authenticated',
      admin: stubAdminUser(),
      session: stubSession({ expiresAt }),
      csrfToken: 'csrf-attendu',
    });
    const access = await resolveAdminAccess(auth as never, sessionToken, { now });
    expect(access.kind).toBe('authenticated');
    expect(access.kind === 'authenticated' && access.csrfToken).toBe('csrf-attendu');
    expect(access.kind === 'authenticated' && access.cookieMaxAgeSeconds).toBe(3600);
  });

  it.each([
    ['invalid', 'invalid'],
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['admin-disabled', 'admin-disabled'],
  ] as const)('résolution %s → unauthenticated/%s', async (status, reason) => {
    const auth = authReturning({ status });
    const access = await resolveAdminAccess(auth as never, sessionToken);
    expect(access).toEqual({ kind: 'unauthenticated', reason });
  });

  it('statut API de refus : 401 sauf admin désactivé (403)', () => {
    expect(adminApiDenyStatus('no-session')).toBe(401);
    expect(adminApiDenyStatus('invalid')).toBe(401);
    expect(adminApiDenyStatus('expired')).toBe(401);
    expect(adminApiDenyStatus('revoked')).toBe(401);
    expect(adminApiDenyStatus('admin-disabled')).toBe(403);
  });

  it('sessionTokenFromCookies lit le cookie namespacé', () => {
    expect(sessionTokenFromCookies(fakeCookies('abc'))).toBe('abc');
    expect(sessionTokenFromCookies(fakeCookies(undefined))).toBeNull();
  });
});

describe('soumission de login (orchestration HTTP)', () => {
  function requestWith(body: Record<string, string>, headers: Record<string, string> = {}) {
    return new Request('https://admin.example.test/admin/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://admin.example.test',
        'sec-fetch-site': 'same-origin',
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    });
  }

  it('succès → token de session + durée de cookie restante', async () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const auth = {
      login: vi.fn(async () => ({
        kind: 'success',
        admin: stubAdminUser(),
        session: stubSession({ expiresAt: new Date(now.getTime() + 120_000) }),
        sessionToken: 'token-brut',
        csrfToken: 'csrf',
      })),
    };
    const result = await processLoginSubmission(auth as never, requestWith({ email: 'a@b.test', password: 'x' }), { now });
    expect(result).toEqual({
      kind: 'success',
      sessionToken: 'token-brut',
      cookieMaxAgeSeconds: 120,
    });
    expect(auth.login).toHaveBeenCalledWith(
      { email: 'a@b.test', password: 'x' },
      expect.objectContaining({ ip: null }),
    );
  });

  it('identifiants invalides → 401, message générique, email préservé, pas de mot de passe', async () => {
    const auth = { login: vi.fn(async () => ({ kind: 'invalid-credentials' })) };
    const result = await processLoginSubmission(
      auth as never,
      requestWith({ email: 'a@b.test', password: 'mot-de-passe-secret' }),
    );
    expect(result).toMatchObject({
      kind: 'render',
      status: 401,
      view: { email: 'a@b.test' },
    });
    expect(
      result.kind === 'render' &&
        JSON.stringify(result.view).includes('mot-de-passe-secret'),
    ).toBe(false);
  });

  it('rate limit → 429 avec message dédié', async () => {
    const auth = { login: vi.fn(async () => ({ kind: 'rate-limited' })) };
    const result = await processLoginSubmission(
      auth as never,
      requestWith({ email: 'a@b.test', password: 'x' }),
    );
    expect(result.kind === 'render' && result.status).toBe(429);
  });

  it('mutation non same-origin → 403 sans appeler le service', async () => {
    const auth = { login: vi.fn() };
    const result = await processLoginSubmission(
      auth as never,
      requestWith({ email: 'a@b.test', password: 'x' }, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(result.kind === 'render' && result.status).toBe(403);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('ip extraite de x-real-ip en priorité, jamais persistée (HMACée en amont)', async () => {
    const auth = {
      login: vi.fn(async () => ({ kind: 'invalid-credentials' })),
    };
    await processLoginSubmission(
      auth as never,
      requestWith(
        { email: 'a@b.test', password: 'x' },
        { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
      ),
    );
    expect(auth.login).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ip: '203.0.113.9' }),
    );
  });
});

describe('environnement admin runtime', () => {
  const validEnv = {
    KREIZ_DATABASE_URL: 'postgresql://user:secret@localhost:5432/kreiz',
    KREIZ_SECRET: 's'.repeat(44),
  };

  it('valide URL + secret et extrait les valeurs', () => {
    expect(parseKreizAdminEnv(validEnv)).toEqual({
      databaseUrl: validEnv.KREIZ_DATABASE_URL,
      secret: validEnv.KREIZ_SECRET,
    });
  });

  it('rejette les environnements incomplets sans fuir les valeurs', () => {
    expect(() => parseKreizAdminEnv({})).toThrow(/KREIZ_DATABASE_URL/);
    expect(() =>
      parseKreizAdminEnv({ KREIZ_DATABASE_URL: 'mysql://nope', KREIZ_SECRET: 'x'.repeat(44) }),
    ).toThrow(/PostgreSQL/);
    expect(() =>
      parseKreizAdminEnv({ ...validEnv, KREIZ_SECRET: 'trop-court' }),
    ).toThrow(/KREIZ_SECRET/);

    // Aucune valeur de secret dans le message d'erreur.
    let message = '';
    try {
      parseKreizAdminEnv({ ...validEnv, KREIZ_SECRET: 'trop-court' });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(validEnv.KREIZ_SECRET);
    expect(message).not.toContain('trop-court');
  });
});
