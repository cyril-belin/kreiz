import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';
import { kreiz } from '@kreiz/core';
import { defineConfig } from 'astro/config';

// apps/demo est un consommateur EXTERNE de @kreiz/core : seule l'API publique
// du package est utilisée. L'intégration injecte les routes du Core
// (/admin/login, /admin, /admin/logout — SSR) et la route de spike.
export default defineConfig({
  output: 'static',
  adapter: vercel(),
  // CSP native Astro (stable depuis Astro 6) : hashes calculés pour les
  // scripts/styles générés, + directives explicites. Complétée côté Core
  // par les en-têtes admin (frame-ancestors, HSTS, noindex…). Non supportée
  // en dev (comportement Astro) : validée au build/preview et en production.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
      ],
    },
  },
  // Le back-office E2E ne doit pas être pollué par la dev toolbar.
  devToolbar: { enabled: false },
  integrations: [
    kreiz({
      spike: { message: 'config fournie par apps/demo' },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
