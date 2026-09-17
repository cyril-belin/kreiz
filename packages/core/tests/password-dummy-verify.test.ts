import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Régression pour le bug corrigé dans src/services/password.ts :
 * `dummyPasswordVerify` mémoïsait la promesse de **vérification** résolue
 * (`dummyVerifyPromise ??= (async () => { ...; return argon2Verify(...); })()`),
 * si bien que seul le tout premier appel du process payait le coût Argon2id
 * — tous les suivants renvoyaient une promesse déjà résolue, quasi
 * instantanément. Sur un serveur long-lived (Vercel à chaud, par exemple),
 * ça recréait exactement le canal de latence que l'appeau est censé fermer
 * (email inconnu ≠ mauvais mot de passe sur un email connu, dès le
 * deuxième essai).
 *
 * Un test basé sur des mesures de temps serait fragile (bruit CI). On
 * instrumente ici directement `@node-rs/argon2` pour prouver la propriété
 * qui compte : `argon2Verify` doit être **réellement rappelé à chaque
 * invocation** de `dummyPasswordVerify` (seul `argon2Hash`, qui ne fait que
 * fabriquer le hachage factice, a le droit d'être mis en cache).
 */
vi.mock('@node-rs/argon2', () => ({
  hash: vi.fn(async (password: string) => `$argon2id$fake$${password}`),
  verify: vi.fn(async () => false),
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('dummyPasswordVerify — coût payé à chaque appel', () => {
  it('rappelle argon2Verify à chaque invocation, sans jamais mettre en cache le résultat', async () => {
    const argon2 = await import('@node-rs/argon2');
    const { dummyPasswordVerify } = await import('../src/services/password');

    await dummyPasswordVerify();
    await dummyPasswordVerify();
    await dummyPasswordVerify();

    // La propriété de sécurité : une vraie vérification Argon2id est
    // exécutée à chaque appel, pas seulement au premier.
    expect(argon2.verify).toHaveBeenCalledTimes(3);
  });

  it('met en cache uniquement la génération du hachage factice', async () => {
    const argon2 = await import('@node-rs/argon2');
    const { dummyPasswordVerify } = await import('../src/services/password');

    await dummyPasswordVerify();
    await dummyPasswordVerify();

    // La génération du hachage factice n'a pas besoin d'être rejouée (il
    // est identique pour tous les appels) — seule la vérification doit
    // rester non mise en cache.
    expect(argon2.hash).toHaveBeenCalledTimes(1);
  });
});
