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

// Origines média dérivées de la configuration de déploiement (revue sécurité
// finale) : la CSP doit autoriser (1) l'upload direct admin vers l'endpoint
// S3 (`connect-src`) et (2) les images des variantes servies par le CDN
// public (`img-src`) — sans quoi la production casse silencieusement les
// médias (l'E2E tourne en dev, où la CSP n'est pas appliquée). Les origines
// ne viennent jamais d'une entrée visiteur : variables d'environnement de
// build/déploiement uniquement.
function storageOrigins(): { uploadOrigin: string | null; publicOrigin: string | null } {
  const origins = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  return {
    uploadOrigin: origins(process.env.KREIZ_STORAGE_ENDPOINT),
    publicOrigin: origins(process.env.KREIZ_STORAGE_PUBLIC_BASE_URL),
  };
}

const media = storageOrigins();
// Préfixes CSP construits dynamiquement depuis l'environnement — typés comme
// les littéraux de directives qu'ils produisent (contrainte du type Astro).
type BuiltCspDirective =
  | `default-src ${string}`
  | `object-src ${string}`
  | `base-uri ${string}`
  | `form-action ${string}`
  | `img-src ${string}`
  | `connect-src ${string}`;
const cspDirectives: BuiltCspDirective[] = [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Images : variantes média servies par le CDN public quand configuré.
  `img-src 'self' data:${media.publicOrigin ? ` ${media.publicOrigin}` : ''}`,
  // Upload direct navigateur → stockage (admin médias).
  ...(media.uploadOrigin ? ([`connect-src 'self' ${media.uploadOrigin}`] as BuiltCspDirective[]) : []),
];

export default defineConfig({
  output: 'static',
  adapter: vercel(),
  // CSP native Astro (stable depuis Astro 6) : hashes calculés pour les
  // scripts/styles générés, + directives explicites. Complétée côté Core
  // par les en-têtes admin (frame-ancestors, HSTS, noindex…). Non supportée
  // en dev (comportement Astro) : validée au build/preview et en production.
  security: {
    csp: {
      directives: cspDirectives,
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
