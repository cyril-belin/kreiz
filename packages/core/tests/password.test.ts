import { describe, expect, it } from 'vitest';
import {
  dummyPasswordVerify,
  hashPassword,
  verifyPassword,
} from '../src/services/password';

describe('hachage Argon2id', () => {
  it('produit une chaîne PHC argon2id avec les paramètres OWASP explicites', async () => {
    const hash = await hashPassword('phrase-longue-de-passe-2026');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
    // Sel aléatoire : deux hachages du même mot de passe diffèrent.
    const other = await hashPassword('phrase-longue-de-passe-2026');
    expect(other).not.toBe(hash);
  });

  it('vérifie le bon mot de passe et refuse un autre', async () => {
    const hash = await hashPassword('phrase-longue-de-passe-2026');
    await expect(verifyPassword(hash, 'phrase-longue-de-passe-2026')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'phrase-longue-de-passe-2027')).resolves.toBe(false);
  });

  it('l’appeau Argon2id (anti-énumération par latence) retourne false et se met en cache', async () => {
    const start = performance.now();
    await expect(dummyPasswordVerify()).resolves.toBe(false);
    const first = performance.now() - start;
    // Second appel : instance mise en cache — toujours false, quasi immédiat.
    const cachedStart = performance.now();
    await expect(dummyPasswordVerify()).resolves.toBe(false);
    expect(performance.now() - cachedStart).toBeLessThan(first);
  });
});
