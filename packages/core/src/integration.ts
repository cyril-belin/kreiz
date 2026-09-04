import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { normalizeKreizConfig, type KreizConfig } from './config.js';
import { kreizConfigVirtualModule } from './vite/config-virtual-module.js';

/**
 * Intégration Astro de Kreiz — point d'entrée public du package.
 *
 * Monte les routes du Core (admin, endpoints, future preview) dans
 * l'application consommatrice et expose la configuration du projet au code
 * du Core via le module virtuel `virtual:kreiz/config`.
 */
export function kreiz(input?: KreizConfig): AstroIntegration {
  const config = normalizeKreizConfig(input ?? {});

  return {
    name: '@kreiz/core',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig }) => {
        updateConfig({
          vite: { plugins: [kreizConfigVirtualModule(config)] },
        });

        injectRoute({
          pattern: '/api/kreiz/spike',
          entrypoint: fileURLToPath(new URL('./routes/spike.js', import.meta.url)),
          prerender: false,
        });
      },
    },
  };
}
