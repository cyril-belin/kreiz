/**
 * Normalisation du base path GitHub Pages. Piège connu (voir docs/website.md)
 * : `import.meta.env.BASE_URL` vaut `/kreiz` **sans slash final** au build et
 * `/` en dev. Toute URL interne du site passe par ici — jamais de
 * concaténation manuelle du préfixe.
 */
const rawBase = import.meta.env.BASE_URL;
export const basePath = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase;

/** Préfixe une route interne du site (`/docs/` → `/kreiz/docs/` au build). */
export const siteUrl = (path: string): string => `${basePath}${path}`;
