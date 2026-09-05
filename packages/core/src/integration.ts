import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { normalizeKreizConfig, type KreizConfig } from './config.js';
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH, ADMIN_LOGOUT_PATH } from './http/admin-routes.js';
import { kreizConfigVirtualModule } from './vite/config-virtual-module.js';

/**
 * Intégration Astro de Kreiz — point d'entrée public du package.
 *
 * Monte les routes du Core (back-office /admin, endpoints d'auth, future
 * preview) dans l'application consommatrice et expose la configuration du
 * projet au code du Core via le module virtuel `virtual:kreiz/config`.
 *
 * Toutes les routes admin sont SSR (`prerender: false`) et autonomes :
 * le projet n'écrit aucune plomberie d'auth (cadrage §5, §10).
 */
export function kreiz(input?: KreizConfig): AstroIntegration {
  const config = normalizeKreizConfig(input ?? {});

  return {
    name: '@kreiz/core',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [kreizConfigVirtualModule(config)],
            // Argon2id embarque un binaire natif (.node) : il doit rester
            // externe au bundle serveur (chargé au runtime depuis
            // node_modules, tracé par l'adaptateur de déploiement) — le
            // bundler ne peut pas le charger comme module JS.
            ssr: { external: ['@node-rs/argon2'] },
          },
        });

        // Route de spike (slice 0) — conservée tant que les routes réelles
        // ne prouvent pas toutes les mêmes invariants (consommation du
        // module virtuel notamment, slice 3).
        injectRoute({
          pattern: '/api/kreiz/spike',
          entrypoint: fileURLToPath(new URL('./routes/spike.js', import.meta.url)),
          prerender: false,
        });

        // Back-office (slice 2) — SSR, sessions serveur, guards, CSRF.
        // Invariant cookie : toutes ces routes vivent sous `/admin/*`
        // (`Path=/admin`), garde mécanique dans `tests/admin-routes.test.ts`.
        injectRoute({
          pattern: ADMIN_LOGIN_PATH,
          entrypoint: fileURLToPath(new URL('./admin/pages/login.astro', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_HOME_PATH,
          entrypoint: fileURLToPath(new URL('./admin/pages/index.astro', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_LOGOUT_PATH,
          entrypoint: fileURLToPath(new URL('./admin/routes/logout.js', import.meta.url)),
          prerender: false,
        });
      },
    },
  };
}
