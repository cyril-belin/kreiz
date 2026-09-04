import type { Plugin } from 'vite';
import type { KreizConfig } from '../config.js';

const MODULE_ID = 'virtual:kreiz/config';
const RESOLVED_ID = '\0virtual:kreiz/config';

/**
 * Expose la configuration de l'application consommatrice au code du Core
 * (routes injectées, futur admin, future preview) via un module virtuel Vite.
 *
 * C'est le sens de dépendance autorisé : Project → Core à l'installation,
 * puis Core → configuration du Project uniquement au travers de ce module
 * typé. Aucun import profond, aucune dépendance inversée.
 */
export function kreizConfigVirtualModule(config: KreizConfig): Plugin {
  return {
    name: '@kreiz/core:virtual-config',
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export default ${JSON.stringify(config)};\n`;
    },
  };
}
