import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

/**
 * Instance Drizzle sur le driver HTTP Neon — cible V1 (cadrage §21.6).
 * Seule cette couche connaît Neon ; ni les routes, ni les services, ni les
 * templates n'importent le driver ou Drizzle directement.
 *
 * Le navigateur ne parle jamais à Neon : cette factory est réservée au code
 * serveur (scripts de l'application, fonctions Astro SSR). Le schéma n'est
 * pas passé à Drizzle : Kreiz utilise l'API core de Drizzle (select/insert)
 * via ses repositories, pas l'API relationnelle `db.query.*`.
 */
export type KreizDatabaseClient = NeonQueryFunction<false, false>;

export type KreizDatabase = NeonHttpDatabase<Record<string, never>> & {
  /** Client Neon attaché — présent dès la factory, requête seulement à l'usage. */
  $client: KreizDatabaseClient;
};

export type KreizDatabaseOptions = {
  /** URL de connexion PostgreSQL (Neon), déjà validée par l'appelant si besoin. */
  databaseUrl: string;
};

export function createKreizDatabase(options: KreizDatabaseOptions): KreizDatabase {
  return drizzle(neon(options.databaseUrl));
}
