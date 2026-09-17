import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';
import { kreiz } from '@kreiz/core';
import { defineConfig } from 'astro/config';
import { articleType, guideType, caseStudyType } from './src/content-types/index.js';
import { contactForm } from './src/forms/contact.js';
import { seoSite } from './src/seo.js';

// apps/demo est un consommateur EXTERNE de @kreiz/core : seule l'API publique
// du package est utilisée. L'intégration injecte les routes du Core (login,
// shell, CRUD contenu, preview, boîte de contact, endpoint public des
// formulaires — toutes SSR) et reçoit ici les types de contenu et les
// formulaires déclarés par le projet (mission §3, cadrage §13).
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
      content: {
        types: [articleType, guideType, caseStudyType],
      },
      forms: [contactForm],
      // SEO (slice 9) — config déclarée en code (src/seo.ts) : le Core en
      // dérive canonical, sitemap, robots.txt et les balises sociales.
      seo: seoSite,
      // Analytics privacy-first (slice 8) — défauts privacy-safe (détails
      // dans docs/slices/slice-8.md) : ici explicite pour la démonstration.
      analytics: {
        enabled: true,
        retentionDays: 90,
        respectPrivacySignals: true,
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
