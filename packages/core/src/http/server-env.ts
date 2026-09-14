import { z } from 'zod';
import {
  createKreizDatabase,
  kreizDatabaseEnvSchema,
  type KreizDatabase,
} from '../data/index.js';
import { createAdminAuthServiceForDatabase, type AdminAuthService } from '../services/admin-auth.js';
import { createNoopRebuildTrigger, type RebuildTrigger } from '../ports/rebuild.js';
import { createVercelDeployHookTrigger } from '../adapters/vercel/rebuild.js';

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
  /**
   * Deploy hook de reconstruction du site (adapter Vercel de référence) —
   * **optionnel** : sans valeur, le port `RebuildTrigger` répond
   * `not-configured` (les publications réussissent, sans rebuild
   * automatique — signal explicite à l'admin). Secret porteur d'URL :
   * jamais loggué, jamais rendu au navigateur (mission §9, §37).
   */
  KREIZ_REBUILD_DEPLOY_HOOK_URL: z.url().optional(),
});

export type KreizAdminEnv = {
  databaseUrl: string;
  secret: string;
  /** URL du deploy hook, ou `null` si aucun moteur de rebuild n'est configuré. */
  rebuildHookUrl: string | null;
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
    rebuildHookUrl: parsed.data.KREIZ_REBUILD_DEPLOY_HOOK_URL ?? null,
  };
}

/**
 * Composition root des routes admin : base + repositories + service auth +
 * port de rebuild. Une instance par tuple d'environnement — reconstruire ne
 * coûte rien (driver HTTP, aucune connexion à l'installation), le cache
 * évite juste le travail répété par requête dans une lambda chaude.
 */
export type KreizAdminRuntime = {
  db: KreizDatabase;
  auth: AdminAuthService;
  /** Port de reconstruction — injecté aux services contenu et publication. */
  rebuild: RebuildTrigger;
  /** Moteur de rebuild configuré, ou `null` — état affiché à l'admin (dashboard). */
  rebuildProvider: 'vercel-deploy-hook' | null;
};

export function createKreizAdminRuntime(env: KreizAdminEnv, options: { allowInsecureRebuildHook?: boolean } = {}): KreizAdminRuntime {
  const db = createKreizDatabase({ databaseUrl: env.databaseUrl });
  const auth = createAdminAuthServiceForDatabase(db, { secret: env.secret });
  // HTTPS imposé hors dev (mission §37) : la production (Vercel) refuse un
  // hook en clair ; dev/tests autorisent un hook local http://127.0.0.1.
  const rebuild: RebuildTrigger = env.rebuildHookUrl
    ? createVercelDeployHookTrigger({
        hookUrl: env.rebuildHookUrl,
        allowInsecureHttp: options.allowInsecureRebuildHook ?? false,
      })
    : createNoopRebuildTrigger();
  return {
    db,
    auth,
    rebuild,
    rebuildProvider: env.rebuildHookUrl ? 'vercel-deploy-hook' : null,
  };
}

let cachedRuntime: { key: string; runtime: KreizAdminRuntime } | null = null;

/**
 * Résout l'environnement du processus et retourne le runtime admin (memoïsé).
 * Le hook de rebuild n'impose HTTPS qu'en production (`import.meta.env.PROD`
 * n'existe que dans le bundle Vite — absent des tests Node purs, qui passent
 * explicitement par `createKreizAdminRuntime`).
 */
export function getKreizAdminRuntime(): KreizAdminRuntime {
  const env = parseKreizAdminEnv(process.env);
  const key = `${env.databaseUrl}\u0000${env.secret}\u0000${env.rebuildHookUrl ?? ''}`;
  if (cachedRuntime?.key !== key) {
    const prod = import.meta.env?.PROD === true;
    cachedRuntime = {
      key,
      runtime: createKreizAdminRuntime(env, { allowInsecureRebuildHook: !prod }),
    };
  }
  return cachedRuntime.runtime;
}
