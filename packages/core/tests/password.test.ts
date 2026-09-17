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

  it('l’appeau Argon2id (anti-énumération par latence) retourne toujours false', async () => {
    await expect(dummyPasswordVerify()).resolves.toBe(false);
    // Appelé plusieurs fois (comme le serait un service long-lived à chaque
    // tentative de login sur un email inconnu) : le hachage factice est mis
    // en cache, mais chaque appel doit rester un résultat correct. La
    // propriété de coût (chaque appel rejoue une vraie vérification Argon2id,
    // jamais une promesse résolue mise en cache) est couverte séparément
    // dans tests/password-dummy-verify.test.ts, où argon2Verify est
    // instrumenté pour compter les appels réels.
    await expect(dummyPasswordVerify()).resolves.toBe(false);
  });
});
