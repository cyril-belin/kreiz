import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { normalizeKreizConfig, type KreizConfig } from './config.js';
import { collectPublicRedirectsConfig } from './content/redirect-materialization.js';
import type { AstroRedirectConfig } from './domain/content/redirect-engine.js';
import { createKreizDatabase } from './data/connection.js';
import {
  ADMIN_CONTENT_DELETE_PATTERN,
  ADMIN_CONTENT_EDIT_PATTERN,
  ADMIN_CONTENT_INDEX_PATH,
  ADMIN_CONTENT_NEW_PATTERN,
  ADMIN_CONTENT_PUBLISH_PATTERN,
  ADMIN_CONTENT_TYPE_PATTERN,
  ADMIN_CONTENT_UNPUBLISH_PATTERN,
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_LOGOUT_PATH,
  ADMIN_MEDIA_ALT_PATTERN,
  ADMIN_MEDIA_CONFIRM_PATTERN,
  ADMIN_MEDIA_DELETE_PATTERN,
  ADMIN_MEDIA_PATH,
  ADMIN_MEDIA_RETRY_PATTERN,
  ADMIN_MEDIA_STATUS_PATTERN,
  ADMIN_MEDIA_UPLOAD_REQUEST_PATH,
  ADMIN_PREVIEW_PATTERN,
  ADMIN_REBUILD_PATH,
} from './http/admin-routes.js';
import { validateDeclarationCrossConstraints } from './domain/content/registry.js';
import {
  kreizConfigVirtualModule,
  resolveTemplatePath,
  templateImportSpecifier,
} from './vite/config-virtual-module.js';

/**
 * Intégration Astro de Kreiz — point d'entrée public du package.
 *
 * Monte les routes du Core (back-office /admin, moteur de contenu, preview)
 * dans l'application consommatrice et expose la configuration du projet —
 * y compris ses types de contenu et leurs templates — au code du Core via
 * le module virtuel `virtual:kreiz/config`.
 *
 * Toutes les routes injectées sont SSR (`prerender: false`) et vivent sous
 * `/admin/*` (invariant du cookie, garde mécanique dans
 * `tests/admin-routes.test.ts`). Le projet n'écrit aucune plomberie :
 * il déclare ses types de contenu (mission §3) et ses templates (§21).
 *
 * Redirections de publication (slice 4) : quand `KREIZ_DATABASE_URL` est
 * présent au build, les redirections 301 issues de `kreiz_redirects` (cibles
 * vivantes uniquement) sont injectées dans la **config native Astro**
 * (`redirects`) — matérialisées en `config.json` par l'adapter de
 * déploiement (Vercel), jamais en SSR. Sans base (PR de fork), aucune
 * redirection n'est injectée et rien n'échoue.
 *
 * La route de spike publique du slice 0 a été supprimée au slice 3 : les
 * routes contenu/preview consomment désormais réellement le module virtuel
 * en production (registre de types, nav admin, preview), prouvant les
 * invariants que le spike portait seul (voir docs/slices/slice-3.md).
 */
export function kreiz(input?: KreizConfig): AstroIntegration {
  const config = normalizeKreizConfig(input ?? {});

  // Fail fast, en Node pur (sans module virtuel ni composants) : chaque
  // type déclaré est bien formé, ses clés et namespaces sont uniques, et
  // chaque template existe sur le disque. Le registre runtime complet
  // (composants joints) est revalidé au premier rendu côté Vite.
  validateDeclarationCrossConstraints(config.content?.types ?? []);

  return {
    name: '@kreiz/core',
    hooks: {
      'astro:config:setup': async ({ injectRoute, updateConfig, config: astroConfig }) => {
        const projectRoot = fileURLToPath(astroConfig.root);

        // Redirections de publication — build-time uniquement, avant toute
        // autre configuration. Une base injoignable échoue explicitement
        // (le build public échouerait de toute façon sur le lecteur de
        // contenu) : on n'expédie jamais un build silencieusement privé de
        // ses redirections.
        let publicRedirects: AstroRedirectConfig = {};
        const databaseUrl = process.env.KREIZ_DATABASE_URL;
        if (databaseUrl) {
          publicRedirects = await collectPublicRedirectsConfig(
            createKreizDatabase({ databaseUrl }),
          );
        }

        updateConfig({
          ...(Object.keys(publicRedirects).length > 0 ? { redirects: publicRedirects } : {}),
          vite: {
            plugins: [
              kreizConfigVirtualModule(config, {
                // Chemin déclaré → chemin absolu (relatif à la racine du
                // projet Astro, existence vérifiée) → spécificateur file://.
                // L'import généré est statique : un chemin faux casse le
                // build, jamais un rendu.
                resolveTemplate: (template) =>
                  templateImportSpecifier(resolveTemplatePath(template, projectRoot)),
              }),
            ],
            // Argon2id embarque un binaire natif (.node) : il doit rester
            // externe au bundle serveur (chargé au runtime depuis
            // node_modules, tracé par l'adaptateur de déploiement) — le
            // bundler ne peut pas le charger comme module JS. Même raison
            // pour Sharp (slice 5, transformation d'images).
            ssr: { external: ['@node-rs/argon2', 'sharp'] },
          },
        });

        // Back-office — SSR, sessions serveur, guards, CSRF (slice 2).
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

        // Moteur de contenu (slice 3) — CRUD générique sur les types
        // déclarés par le Project + preview SSR avec le vrai template.
        injectRoute({
          pattern: ADMIN_CONTENT_INDEX_PATH,
          entrypoint: fileURLToPath(
            new URL('./admin/pages/content/index.astro', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_CONTENT_TYPE_PATTERN,
          entrypoint: fileURLToPath(
            new URL('./admin/pages/content/listing.astro', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_CONTENT_NEW_PATTERN,
          entrypoint: fileURLToPath(
            new URL('./admin/pages/content/new.astro', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_CONTENT_EDIT_PATTERN,
          entrypoint: fileURLToPath(
            new URL('./admin/pages/content/edit.astro', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_CONTENT_DELETE_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/content-delete.js', import.meta.url)),
          prerender: false,
        });
        // Publication / dépublication / rebuild manuel (slice 4) — mutations
        // POST sous le même invariant /admin.
        injectRoute({
          pattern: ADMIN_CONTENT_PUBLISH_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/content-publish.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_CONTENT_UNPUBLISH_PATTERN,
          entrypoint: fileURLToPath(
            new URL('./admin/routes/content-unpublish.js', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_REBUILD_PATH,
          entrypoint: fileURLToPath(new URL('./admin/routes/site-rebuild.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_PREVIEW_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/pages/preview.astro', import.meta.url)),
          prerender: false,
        });

        // Médias (slice 5) — médiathèque, upload présigné, confirmation,
        // polling, alt, retry, suppression. Toutes SSR sous /admin.
        injectRoute({
          pattern: ADMIN_MEDIA_PATH,
          entrypoint: fileURLToPath(new URL('./admin/pages/media/index.astro', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_UPLOAD_REQUEST_PATH,
          entrypoint: fileURLToPath(
            new URL('./admin/routes/media-upload-request.js', import.meta.url),
          ),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_CONFIRM_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/media-confirm.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_STATUS_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/media-status.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_ALT_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/media-alt.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_RETRY_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/media-retry.js', import.meta.url)),
          prerender: false,
        });
        injectRoute({
          pattern: ADMIN_MEDIA_DELETE_PATTERN,
          entrypoint: fileURLToPath(new URL('./admin/routes/media-delete.js', import.meta.url)),
          prerender: false,
        });
      },
    },
  };
}
