import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  csrfTokensMatch,
  deriveSessionCsrfToken,
  generateSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  pseudonymizeIp,
} from '../src/services/auth-tokens';

describe('token de session', () => {
  it('encode 32 octets aléatoires (256 bits d’entropie) en base64url', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('est unique en travers de tirages répétés', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(1000);
  });

  it('isPlausibleSessionToken filtre avant tout lookup DB', () => {
    expect(isPlausibleSessionToken(generateSessionToken())).toBe(true);
    expect(isPlausibleSessionToken('court')).toBe(false);
    expect(isPlausibleSessionToken('')).toBe(false);
    expect(isPlausibleSessionToken(undefined)).toBe(false);
    expect(isPlausibleSessionToken(null)).toBe(false);
  });
});

describe('hash du token', () => {
  it('stocke uniquement SHA-256 hex — jamais le token brut', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hash).not.toContain(token);
  });

  it('est déterministe et distinct par token', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(hashSessionToken(a)).toBe(hashSessionToken(a));
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });
});

describe('token CSRF lié à la session', () => {
  it('est dérivé par HMAC-SHA256 — imprévisible sans le token', () => {
    const token = generateSessionToken();
    const csrf = deriveSessionCsrfToken(token);
    expect(csrf).toHaveLength(64);
    expect(csrf).toMatch(/^[0-9a-f]+$/);
    expect(csrf).toBe(
      createHmac('sha256', token).update('kreiz:csrf:v1').digest('hex'),
    );
    expect(csrf).not.toContain(token);
  });

  it('change à chaque session (renouvellement quand la session change)', () => {
    const a = deriveSessionCsrfToken(generateSessionToken());
    const b = deriveSessionCsrfToken(generateSessionToken());
    expect(a).not.toBe(b);
  });

  it('vérification à temps constant — égalité stricte uniquement', () => {
    const token = generateSessionToken();
    const csrf = deriveSessionCsrfToken(token);
    expect(csrfTokensMatch(csrf, csrf)).toBe(true);
    expect(csrfTokensMatch(csrf, `${csrf}0`)).toBe(false); // longueurs différentes
    expect(csrfTokensMatch(csrf, 'f'.repeat(64))).toBe(false);
  });
});

describe('pseudonymisation d’IP', () => {
  it('HMAC à clé secrète — déterministe, distinct par IP et par secret', () => {
    const secret = 'secret-de-deploiement-tres-long';
    const a = pseudonymizeIp('203.0.113.7', secret);
    const b = pseudonymizeIp('203.0.113.8', secret);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(pseudonymizeIp('203.0.113.7', secret));
    expect(a).not.toBe(b);
    expect(a).not.toBe(pseudonymizeIp('203.0.113.7', 'autre-secret-de-deploiement'));
  });

  it('ne réutilise jamais le même libellé entre domaines', () => {
    const secret = 'secret-de-deploiement-tres-long';
    // L'email et l'IP partagent le secret mais pas le libellé : deux
    // pseudonymes distincts même pour une valeur identique.
    expect(pseudonymizeIp('x', secret)).not.toBe(
      createHmac('sha256', secret).update('autre-label:x').digest('hex'),
    );
  });
});
