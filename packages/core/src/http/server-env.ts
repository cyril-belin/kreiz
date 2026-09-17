import { z } from 'zod';
import { createS3ObjectStorage, S3ObjectStorage } from '../adapters/storage/s3.js';
import { createWebhookMailer } from '../adapters/mailer/webhook.js';
import type { MailAddress, Mailer } from '../ports/mailer.js';
import { createKreizDatabase, type KreizDatabase } from '../data/connection.js';
import { kreizDatabaseEnvSchema } from '../data/env.js';
import { createAdminAuthServiceForDatabase, type AdminAuthService } from '../services/admin-auth.js';
import { createNoopRebuildTrigger, type RebuildTrigger } from '../ports/rebuild.js';
import { createVercelDeployHookTrigger } from '../adapters/vercel/rebuild.js';
import { isSafeEmailAddress, isSafeHeaderValue } from '../domain/forms/policy.js';

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
  /**
   * Bloc mail (formulaires, slice 7) — **optionnel** ; l'URL du relais
   * implique l'expéditeur d'enveloppe (`KREIZ_MAIL_FROM_EMAIL`, tout ou
   * rien : jamais un mailer à moitié câblé). Le token porteur est
   * optionnel mais exige l'URL. Secrets : jamais loggués, jamais rendus.
   */
  KREIZ_MAIL_WEBHOOK_URL: z.url().optional(),
  KREIZ_MAIL_WEBHOOK_TOKEN: z.string().min(1).max(255).optional(),
  KREIZ_MAIL_FROM_EMAIL: z.string().optional(),
  KREIZ_MAIL_FROM_NAME: z
    .string()
    .min(1)
    .max(120)
    .refine(isSafeHeaderValue, 'KREIZ_MAIL_FROM_NAME invalide (aucun caractère de contrôle)')
    .optional(),
}).superRefine((value, ctx) => {
  const hasUrl = value.KREIZ_MAIL_WEBHOOK_URL !== undefined && value.KREIZ_MAIL_WEBHOOK_URL !== '';
  const hasFrom = value.KREIZ_MAIL_FROM_EMAIL !== undefined && value.KREIZ_MAIL_FROM_EMAIL !== '';
  const hasToken = value.KREIZ_MAIL_WEBHOOK_TOKEN !== undefined && value.KREIZ_MAIL_WEBHOOK_TOKEN !== '';
  if (!hasUrl && hasToken) {
    ctx.addIssue({
      code: 'custom',
      path: ['KREIZ_MAIL_WEBHOOK_TOKEN'],
      message: 'KREIZ_MAIL_WEBHOOK_TOKEN est défini sans KREIZ_MAIL_WEBHOOK_URL — définissez le relais aussi.',
    });
  }
  if (hasUrl && !hasFrom) {
    ctx.addIssue({
      code: 'custom',
      path: ['KREIZ_MAIL_FROM_EMAIL'],
      message: 'bloc mail incomplet — KREIZ_MAIL_FROM_EMAIL est requis quand KREIZ_MAIL_WEBHOOK_URL est défini.',
    });
  }
  if (hasFrom && !isSafeEmailAddress(value.KREIZ_MAIL_FROM_EMAIL ?? '')) {
    ctx.addIssue({
      code: 'custom',
      path: ['KREIZ_MAIL_FROM_EMAIL'],
      message: 'KREIZ_MAIL_FROM_EMAIL doit être une adresse email valide (aucun caractère de contrôle).',
    });
  }
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
  /** Configuration du relais email, ou `null` si aucun transport n'est configuré. */
  mail: {
    webhookUrl: string;
    webhookToken: string | null;
    from: MailAddress;
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
  const mail =
    data.KREIZ_MAIL_WEBHOOK_URL && data.KREIZ_MAIL_FROM_EMAIL
      ? {
          webhookUrl: data.KREIZ_MAIL_WEBHOOK_URL,
          webhookToken: data.KREIZ_MAIL_WEBHOOK_TOKEN ?? null,
          from: {
            email: data.KREIZ_MAIL_FROM_EMAIL,
            ...(data.KREIZ_MAIL_FROM_NAME ? { name: data.KREIZ_MAIL_FROM_NAME } : {}),
          },
        }
      : null;
  return {
    databaseUrl: data.KREIZ_DATABASE_URL,
    secret: data.KREIZ_SECRET,
    rebuildHookUrl: data.KREIZ_REBUILD_DEPLOY_HOOK_URL ?? null,
    storage,
    mail,
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
  /** Port Mailer configuré, ou `null` — les demandes restent stockées sans lui (slice 7). */
  mailer: Mailer | null;
  /** Expéditeur d'enveloppe des notifications, ou `null` (lié au bloc mail). */
  mailFrom: MailAddress | null;
  /**
   * Secret de déploiement — signatures du domaine contact (jeton
   * d'émission, idempotence). Server-side uniquement, jamais rendu.
   */
  secret: string;
};

export function createKreizAdminRuntime(env: KreizAdminEnv, options: { allowInsecureRebuildHook?: boolean; allowInsecureMailWebhook?: boolean } = {}): KreizAdminRuntime {
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
  // Relais email (slice 7) : mêmes règles que le deploy hook (HTTPS en
  // production, URL secrète jamais exposée).
  const mailer: Mailer | null = env.mail
    ? createWebhookMailer({
        webhookUrl: env.mail.webhookUrl,
        ...(env.mail.webhookToken ? { token: env.mail.webhookToken } : {}),
        allowInsecureHttp: options.allowInsecureMailWebhook ?? false,
      })
    : null;
  return {
    db,
    auth,
    rebuild,
    rebuildProvider: env.rebuildHookUrl ? 'vercel-deploy-hook' : null,
    storage,
    mediaPublicBaseUrl: env.storage?.publicBaseUrl ?? null,
    mailer,
    mailFrom: env.mail?.from ?? null,
    secret: env.secret,
  };
}

let cachedRuntime: { key: string; runtime: KreizAdminRuntime } | null = null;

/**
 * Résout l'environnement du processus et retourne le runtime admin (memoïsé).
 * Le hook de rebuild et le relais email n'imposent HTTPS qu'en production
 * (`import.meta.env.PROD` n'existe que dans le bundle Vite — absent des
 * tests Node purs, qui passent explicitement par `createKreizAdminRuntime`).
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
    env.mail?.webhookUrl ?? '',
    env.mail?.webhookToken ?? '',
    env.mail?.from.email ?? '',
    env.mail?.from.name ?? '',
  ].join('\u0000');
  if (cachedRuntime?.key !== key) {
    const prod = import.meta.env?.PROD === true;
    cachedRuntime = {
      key,
      runtime: createKreizAdminRuntime(env, {
        allowInsecureRebuildHook: !prod,
        allowInsecureMailWebhook: !prod,
      }),
    };
  }
  return cachedRuntime.runtime;
}
