import { z } from 'zod';
import { createS3ObjectStorage, S3ObjectStorage } from '../adapters/storage/s3.js';
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
 * l'environnement. Les secrets ne sont jamais journalisés ni renvoyés au
 * navigateur.
 */

/**
 * Bloc storage S3-compatible (mission §8) — **tout ou rien** : présenter
 * une variable sans les autres est une erreur explicite (jamais un média
 * à moitié configuré). `KREIZ_STORAGE_REGION` est optionnel (défaut
 * `us-east-1`, `auto` chez R2). La base publique est requise avec le bloc :
 * les variantes doivent pouvoir être servies (thumbnails admin, pages
 * publiques).
 */
export const kreizStorageEnvSchema = z
  .object({
    KREIZ_STORAGE_ENDPOINT: z.url().optional(),
    KREIZ_STORAGE_BUCKET: z.string().min(1).max(255).optional(),
    KREIZ_STORAGE_ACCESS_KEY_ID: z.string().min(1).max(255).optional(),
    KREIZ_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).max(255).optional(),
    KREIZ_STORAGE_REGION: z.string().min(1).max(64).optional(),
    KREIZ_STORAGE_PUBLIC_BASE_URL: z.url().optional(),
  })
  .superRefine((value, ctx) => {
    const required = [
      'KREIZ_STORAGE_ENDPOINT',
      'KREIZ_STORAGE_BUCKET',
      'KREIZ_STORAGE_ACCESS_KEY_ID',
      'KREIZ_STORAGE_SECRET_ACCESS_KEY',
      'KREIZ_STORAGE_PUBLIC_BASE_URL',
    ] as const;
    const present = required.filter((key) => value[key] !== undefined && value[key] !== '');
    if (present.length > 0 && present.length < required.length) {
      const missing = required.filter((key) => !present.includes(key));
      for (const path of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message:
            'bloc storage incomplet — toutes les variables KREIZ_STORAGE_* obligatoires doivent être définies ensemble',
        });
      }
    }
  });

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
  /** Bloc storage S3-compatible (médias, slice 5) — optionnel, tout ou rien. */
  ...kreizStorageEnvSchema.shape,
});

export type KreizAdminEnv = {
  databaseUrl: string;
  secret: string;
  /** URL du deploy hook, ou `null` si aucun moteur de rebuild n'est configuré. */
  rebuildHookUrl: string | null;
  /** Configuration storage validée, ou `null` si aucun stockage n'est configuré. */
  storage: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string | null;
    publicBaseUrl: string;
  } | null;
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
  const data = parsed.data as z.infer<typeof kreizAdminEnvSchema>;
  const storage =
    data.KREIZ_STORAGE_ENDPOINT && data.KREIZ_STORAGE_BUCKET && data.KREIZ_STORAGE_ACCESS_KEY_ID && data.KREIZ_STORAGE_SECRET_ACCESS_KEY && data.KREIZ_STORAGE_PUBLIC_BASE_URL
      ? {
          endpoint: data.KREIZ_STORAGE_ENDPOINT,
          bucket: data.KREIZ_STORAGE_BUCKET,
          accessKeyId: data.KREIZ_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: data.KREIZ_STORAGE_SECRET_ACCESS_KEY,
          region: data.KREIZ_STORAGE_REGION ?? null,
          publicBaseUrl: data.KREIZ_STORAGE_PUBLIC_BASE_URL,
        }
      : null;
  return {
    databaseUrl: data.KREIZ_DATABASE_URL,
    secret: data.KREIZ_SECRET,
    rebuildHookUrl: data.KREIZ_REBUILD_DEPLOY_HOOK_URL ?? null,
    storage,
  };
}

/**
 * Composition root des routes admin : base + repositories + service auth +
 * port de rebuild + storage média. Une instance par tuple d'environnement —
 * reconstruire ne coûte rien (driver HTTP, aucune connexion à
 * l'installation), le cache évite juste le travail répété par requête dans
 * une lambda chaude.
 */
export type KreizAdminRuntime = {
  db: KreizDatabase;
  auth: AdminAuthService;
  /** Port de reconstruction — injecté aux services contenu et publication. */
  rebuild: RebuildTrigger;
  /** Moteur de rebuild configuré, ou `null` — état affiché à l'admin (dashboard). */
  rebuildProvider: 'vercel-deploy-hook' | null;
  /** Stockage objet configuré, ou `null` — état affiché à l'admin (médias). */
  storage: S3ObjectStorage | null;
  /** Base publique des variantes, ou `null` — résolution des URLs publiques. */
  mediaPublicBaseUrl: string | null;
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
  // Storage média : HTTP en clair toléré pour un endpoint local (MinIO,
  // s3rver en test) — l'endpoint est une URL de service, pas une URL
  // portoire de secret comme le deploy hook.
  const storage = env.storage
    ? createS3ObjectStorage({
        endpoint: env.storage.endpoint,
        bucket: env.storage.bucket,
        accessKeyId: env.storage.accessKeyId,
        secretAccessKey: env.storage.secretAccessKey,
        publicBaseUrl: env.storage.publicBaseUrl,
        ...(env.storage.region ? { region: env.storage.region } : {}),
      })
    : null;
  return {
    db,
    auth,
    rebuild,
    rebuildProvider: env.rebuildHookUrl ? 'vercel-deploy-hook' : null,
    storage,
    mediaPublicBaseUrl: env.storage?.publicBaseUrl ?? null,
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
  const key = [
    env.databaseUrl,
    env.secret,
    env.rebuildHookUrl ?? '',
    env.storage?.endpoint ?? '',
    env.storage?.bucket ?? '',
    env.storage?.accessKeyId ?? '',
    env.storage?.secretAccessKey ?? '',
    env.storage?.region ?? '',
    env.storage?.publicBaseUrl ?? '',
  ].join('\u0000');
  if (cachedRuntime?.key !== key) {
    const prod = import.meta.env?.PROD === true;
    cachedRuntime = {
      key,
      runtime: createKreizAdminRuntime(env, { allowInsecureRebuildHook: !prod }),
    };
  }
  return cachedRuntime.runtime;
}
