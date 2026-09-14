import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import type { KreizConfig } from '../config.js';

const MODULE_ID = 'virtual:kreiz/config';
const RESOLVED_ID = '\0virtual:kreiz/config';

/**
 * Expose la configuration de l'application consommatrice au code du Core
 * (routes injectées, admin, preview) via un module virtuel Vite.
 *
 * C'est le sens de dépendance autorisé : Project → Core à l'installation,
 * puis Core → configuration du Project uniquement au travers de ce module
 * typé. Aucun import profond, aucune dépendance inversée.
 *
 * **Templates Project** (slice 3) : un composant `.astro` n'est pas
 * sérialisable en JSON — impossible de le faire voyager dans le défaut du
 * module. Le module exporte donc aussi `contentTemplates` : un mapping
 * `key → composant` alimenté par des **imports statiques** générés depuis
 * les chemins déclarés. Imports statiques (et non dynamiques) : résolus à
 * la construction du bundle, donc détectés au build — un chemin faux est
 * une erreur de build, pas un 500 au runtime. La preview SSR et le futur
 * rendu public partagent exactement ces composants (mission §21).
 */
export function kreizConfigVirtualModule(
  config: KreizConfig,
  options: { resolveTemplate: (template: string) => string } = { resolveTemplate: defaultResolveTemplate },
): Plugin {
  const declarations = config.content?.types ?? [];
  return {
    name: '@kreiz/core:virtual-config',
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const lines: string[] = [];
      declarations.forEach((declaration, index) => {
        const specifier = options.resolveTemplate(declaration.template);
        lines.push(`import * as template_${index} from '${specifier}';`);
      });
      // Config sérialisée — les composants (non sérialisables) voyagent à
      // part via contentTemplates.
      lines.push(`const config = ${JSON.stringify(config)};`);
      lines.push('export default config;');
      lines.push('export const contentTemplates = {');
      declarations.forEach((declaration, index) => {
        lines.push(`  ${JSON.stringify(declaration.key)}: template_${index}.default ?? template_${index},`);
      });
      lines.push('};');
      return `${lines.join('\n')}\n`;
    },
  };
}

/**
 * Résolution d'un chemin de template : absolu tel quel, sinon relatif à la
 * **racine du projet Astro** (injectée par l'intégration). Le fichier doit
 * exister au moment de la config — un chemin faux est une erreur de
 * démarrage claire, pas un échec de build obscur.
 */
export function resolveTemplatePath(template: string, projectRoot: string): string {
  const absolute = isAbsolute(template) ? template : resolve(projectRoot, template);
  if (!existsSync(absolute)) {
    throw new Error(
      `@kreiz/core : template de contenu introuvable « ${template} » (résolu : ${absolute}) — le composant .astro déclaré doit exister.`,
    );
  }
  return absolute;
}

/** Spécificateur d'import pour Vite — URL fichier (robuste Windows compris). */
export function templateImportSpecifier(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

function defaultResolveTemplate(template: string): string {
  return template;
}
