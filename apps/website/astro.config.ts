import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vitrine officielle Kreiz — site 100 % statique, sans adapter, sans base de
 * données, sans secret. Déployée sur GitHub Pages à
 * https://cyril-belin.github.io/kreiz/.
 *
 * `base` n'est nécessaire que pour GitHub Pages, qui sert les sites de
 * projets sous /<repo>/ : il ne s'applique donc qu'au BUILD (`astro build`
 * pose NODE_ENV=production). En dev, le serveur sert la landing à la racine
 * — http://localhost:4321/ — pas sous /kreiz/.
 *
 * Domaine custom plus tard : passer `site` sur le domaine et supprimer le
 * `base` conditionnel, puis adapter l'URL canonique/OG dans
 * src/pages/index.astro (elle est dérivée d'ici).
 */
const isBuild = process.env.NODE_ENV !== 'development';

export default defineConfig({
  site: 'https://cyril-belin.github.io',
  base: isBuild ? '/kreiz' : '/',
  vite: {
    plugins: [tailwindcss()],
  },
});
