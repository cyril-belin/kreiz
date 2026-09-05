import { z } from 'zod';
import {
  createKreizDatabase,
  kreizDatabaseEnvSchema,
  type KreizDatabase,
} from '../data/index.js';
import { createAdminAuthServiceForDatabase, type AdminAuthService } from '../services/admin-auth.js';

/**
 * Environnement runtime des routes admin injectées par le Core.
 *
 * Les routes Kreiz vivent dans l'application consommatrice : personne
 * d'autre que le Core ne traite ces requêtes, c'est donc lui qui lit
 * `process.env` — explicitement, via ce schéma validé (Zod), et **uniquement
 * ici**. Le domaine et les services reçoivent des valeurs, jamais
 * l'environnement. Le secret n'est jamais journalisé ni renvoyé au
 * navigateur.
 */
export const kreizAdminEnvSchema = z.object({
  KREIZ_DATABASE_URL: kreizDatabaseEnvSchema.shape.KREIZ_DATABASE_URL,
  /** ≥ 32 caractères — clé HMAC de pseudonymisation des IP (rate limiting). */
  KREIZ_SECRET: z.string().min(32),
});

export type KreizAdminEnv = {
  databaseUrl: string;
  secret: string;
};

/** Valide un environnement et extrait les valeurs admin runtime. */
export function parseKreizAdminEnv(env: unknown): KreizAdminEnv {
  const parsed = kreizAdminEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'}: ${issue.message}`)
      .join(' ; ');
    throw new Error(`@kreiz/core : environnement admin invalide — ${issues}`);
  }
  return {
    databaseUrl: parsed.data.KREIZ_DATABASE_URL,
    secret: parsed.data.KREIZ_SECRET,
  };
}

/**
 * Composition root des routes admin : base + repositories + service auth.
 * Une instance par couple (URL, secret) — reconstruire ne coûte rien
 * (driver HTTP, aucune connexion à l'installation), le cache évite juste
 * le travail répété par requête dans une lambda chaude.
 */
export type KreizAdminRuntime = {
  db: KreizDatabase;
  auth: AdminAuthService;
};

export function createKreizAdminRuntime(env: KreizAdminEnv): KreizAdminRuntime {
  const db = createKreizDatabase({ databaseUrl: env.databaseUrl });
  const auth = createAdminAuthServiceForDatabase(db, { secret: env.secret });
  return { db, auth };
}

let cachedRuntime: { key: string; runtime: KreizAdminRuntime } | null = null;

/** Résout l'environnement du processus et retourne le runtime admin (memoïsé). */
export function getKreizAdminRuntime(): KreizAdminRuntime {
  const env = parseKreizAdminEnv(process.env);
  const key = `${env.databaseUrl}\u0000${env.secret}`;
  if (cachedRuntime?.key !== key) {
    cachedRuntime = { key, runtime: createKreizAdminRuntime(env) };
  }
  return cachedRuntime.runtime;
}
