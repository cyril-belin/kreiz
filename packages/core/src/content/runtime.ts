import config, { contentTemplates } from 'virtual:kreiz/config';
import { createContentTypeRegistry, type ContentTypeRegistry } from '../domain/content/registry.js';

/**
 * Registre runtime des types de contenu — la fin du canal
 * `Project → kreiz(...) → virtual:kreiz/config → Core` (mission §8).
 *
 * Les déclarations sérialisées et les composants de template importés par
 * le module virtuel sont joints et revalidés ici. Memoïsé par processus :
 * le module virtuel est une constante du bundle, la revalidation ne doit
 * pas repayer par requête.
 *
 * Ce module n'est importable **que** dans un contexte Vite/Astro (le module
 * virtuel n'existe pas ailleurs) : les pages admin du Core et la preview
 * y accèdent via `getKreizAdminRuntime()` (http/admin-runtime.ts). Les
 * services et le domaine reçoivent un registre injecté — jamais cet import
 * — pour rester testables sans bundler.
 */

let cachedRegistry: ContentTypeRegistry | null = null;

export function getContentRegistry(): ContentTypeRegistry {
  cachedRegistry ??= createContentTypeRegistry({
    declarations: config.content?.types ?? [],
    templates: contentTemplates,
  });
  return cachedRegistry;
}
