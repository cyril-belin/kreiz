import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';
import { kreiz } from '@kreiz/core';
import { defineConfig } from 'astro/config';

// apps/demo est un consommateur EXTERNE de @kreiz/core : seule l'API publique
// du package est utilisée. L'intégration injecte les routes du Core.
export default defineConfig({
  output: 'static',
  adapter: vercel(),
  integrations: [
    kreiz({
      spike: { message: 'config fournie par apps/demo' },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
