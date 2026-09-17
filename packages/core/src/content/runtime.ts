import config, { contentTemplates } from 'virtual:kreiz/config';
import { createContentTypeRegistry, type ContentTypeRegistry } from '../domain/content/registry.js';
import type { SeoSiteConfig } from '../domain/seo/site-config.js';

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

/**
 * Configuration SEO du site résolue (slice 9) — injectée aux services
 * contenu/publication (validation des overrides canoniques). `null` quand
 * le Project n'a pas configuré de bloc `seo` : les overrides canoniques
 * absolus sont alors refusés, jamais dérivés d'un Host.
 */
export function getKreizSeoSiteConfig(): SeoSiteConfig | null {
  return config.seo ?? null;
}
