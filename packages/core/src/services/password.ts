import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Hachage de mot de passe — Argon2id via `@node-rs/argon2` (binding NAPI-RS
 * d'argon2-rust, binaires précompilés pour les plateformes cibles, dont
 * l'environnement serverless Vercel — pas de build from source).
 *
 * Paramètres : recommandations OWASP (2024) — m = 19 MiB (19456 KiB),
 * t = 2, p = 1. Ce sont aussi les défauts de la bibliothèque ; ils sont
 * écrits explicitement pour que le coût soit visible et revendiqué, pas
 * hérité silencieusement. Le sel aléatoire est généré par la bibliothèque
 * (16 octets) et encodé dans la chaîne PHC stockée en
 * `kreiz_admin_users.password_hash`.
 *
 * `algorithm: 2` est `Algorithm.Argon2id` (const enum ambiant du binding,
 * inaccessible en valeur sous verbatimModuleSyntax). Le PHC produit porte
 * bien `$argon2id$`.
 */
const ARGON2ID_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hache un mot de passe (chaîne PHC argon2id complète). */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2ID_OPTIONS);
}

/** Vérifie un mot de passe contre une chaîne PHC existante. */
export function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return argon2Verify(storedHash, password);
}

/**
 * Vérification « appeau » : même coût Argon2id sur un email inconnu, pour
 * égaliser la latence des réponses de login et ne pas permettre la
 * détection d'un compte existant par le temps de réponse. Le résultat est
 * mis en cache par processus (le hachage factice est identique pour tous).
 */
let dummyVerifyPromise: Promise<boolean> | null = null;
export function dummyPasswordVerify(): Promise<boolean> {
  dummyVerifyPromise ??= (async () => {
    const dummyHash = await argon2Hash(crypto.randomUUID(), ARGON2ID_OPTIONS);
    return argon2Verify(dummyHash, 'mot-de-passe-factice');
  })();
  return dummyVerifyPromise;
}
