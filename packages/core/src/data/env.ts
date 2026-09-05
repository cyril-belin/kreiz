import { z } from 'zod';

/**
 * Environnement requis par la couche data de Kreiz.
 *
 * Le Core ne lit **jamais** `process.env` de façon magique au milieu du
 * domaine : l'application passe explicitement son environnement (ou une
 * valeur) aux helpers ci-dessous, et c'est elle qui décide du moment.
 */
export const kreizDatabaseEnvSchema = z.object({
  KREIZ_DATABASE_URL: z
    .url()
    .refine(
      (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
      'doit être une URL PostgreSQL (postgresql://… ou postgres://…)',
    ),
});

export type KreizDatabaseEnv = z.infer<typeof kreizDatabaseEnvSchema>;

/** Valide un environnement et retourne la variable `KREIZ_DATABASE_URL`. */
export function parseKreizDatabaseEnv(env: unknown): KreizDatabaseEnv {
  const parsed = kreizDatabaseEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'}: ${issue.message}`)
      .join(' ; ');
    throw new Error(`@kreiz/core : environnement data invalide — ${issues}`);
  }
  return parsed.data;
}
