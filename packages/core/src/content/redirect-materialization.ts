import type { KreizDatabase } from '../data/connection.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createRedirectsRepository } from '../data/repositories/redirects.js';
import {
  astroRedirectsConfig,
  materializableRedirects,
  type AstroRedirectConfig,
} from '../domain/content/redirect-engine.js';

/**
 * Matérialisation des redirections **au build** (cadrage §12, mission §25).
 *
 * Le build lit `kreiz_redirects` et produit une configuration de build —
 * ici la carte `redirects` native d'Astro, que l'adapter Vercel matérialise
 * en `config.json` (301 permanents, mission §26). Le site public reste
 * entièrement statique : aucune route SSR dédiée aux redirections.
 *
 * Ne sont émises que les redirections dont la **cible est vivante** — une
 * redirection vers une page dépubliée ou supprimée ne masque pas un 404
 * honnête (`materializableRedirects`, gardes défensives de terminalité
 * incluses). L'abstraction reste portable : la carte produite est de la
 * configuration de build Astro, pas du Vercel brut.
 */
export async function collectPublicRedirectsConfig(
  db: KreizDatabase,
): Promise<AstroRedirectConfig> {
  const [rows, routes] = await Promise.all([
    createRedirectsRepository(db).listAll(),
    createContentEntriesRepository(db).listPublishedRoutes(),
  ]);
  return astroRedirectsConfig(materializableRedirects(rows, routes));
}
