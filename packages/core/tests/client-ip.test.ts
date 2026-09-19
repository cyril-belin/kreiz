import { describe, expect, it } from 'vitest';
import { bucketIpForRateLimiting, clientIpFromHeaders } from '../src/http/admin-login';

/**
 * Extraction et normalisation de l'IP de rate limiting (revue sécurité
 * finale) — l'identité par IP doit survivre à la rotation d'adresses dans un
 * /64 IPv6, sans bucketiser l'IPv4 (CGNAT : des visiteurs légitimes partagent
 * une sortie).
 */
describe('bucketIpForRateLimiting', () => {
  it('IPv4 inchangée (pas de bucket /24 — CGNAT)', () => {
    expect(bucketIpForRateLimiting('203.0.113.7')).toBe('203.0.113.7');
    expect(bucketIpForRateLimiting('10.0.0.1')).toBe('10.0.0.1');
  });

  it('IPv6 réduite à son préfixe /64 (adresse expansée)', () => {
    expect(bucketIpForRateLimiting('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
      '2001:0db8:85a3:0000::/64',
    );
  });

  it('IPv6 abrégée : expansion correcte avant découpe', () => {
    expect(bucketIpForRateLimiting('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3:0::/64');
    expect(bucketIpForRateLimiting('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(bucketIpForRateLimiting('::1')).toBe('0:0:0:0::/64');
  });

  it('la rotation dans un /64 produit la même identité', () => {
    const a = bucketIpForRateLimiting('2001:db8:85a3::1');
    const b = bucketIpForRateLimiting('2001:db8:85a3::ffff:abcd');
    expect(a).toBe(b);
  });

  it('IPv4-mappée inchangée (identité v4 lisible)', () => {
    expect(bucketIpForRateLimiting('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
  });

  it('valeurs opaques tolérées telles quelles', () => {
    expect(bucketIpForRateLimiting('unknown')).toBe('unknown');
    expect(bucketIpForRateLimiting(':::::')).toBe(':::::');
  });
});

describe('clientIpFromHeaders — ordre de confiance et bucketisation', () => {
  it('x-real-ip d’abord, bucketisé', () => {
    const headers = new Headers({
      'x-real-ip': '2001:db8::1',
      'x-vercel-forwarded-for': '198.51.100.9',
      'x-forwarded-for': '192.0.2.1',
    });
    expect(clientIpFromHeaders(headers)).toBe('2001:db8:0:0::/64');
  });

  it('x-vercel-forwarded-for ensuite (première entrée)', () => {
    const headers = new Headers({ 'x-vercel-forwarded-for': '198.51.100.9, 192.0.2.1' });
    expect(clientIpFromHeaders(headers)).toBe('198.51.100.9');
  });

  it('x-forwarded-for en secours (première entrée, bucketisée)', () => {
    const headers = new Headers({ 'x-forwarded-for': '2001:db8::abcd, 192.0.2.1' });
    expect(clientIpFromHeaders(headers)).toBe('2001:db8:0:0::/64');
  });

  it('aucun en-tête → null', () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});
