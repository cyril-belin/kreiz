import { getContentRegistry } from '../content/runtime.js';
import { createAdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createContentService, type ContentService } from '../services/content.js';
import { getKreizAdminRuntime, type KreizAdminRuntime } from './server-env.js';

/**
 * Composition root des pages du moteur de contenu : runtime admin (base +
 * auth) **plus** le service contenu construit sur le registre des types du
 * Project (module virtuel). Memoïsé par identité du runtime de base — une
 * seule revalidation du registre par processus.
 *
 * Ce module n'est importable que dans un contexte Vite/Astro (il tire le
 * module virtuel) : les services et tests injectent un registre explicite.
 */
export interface KreizContentRuntime extends KreizAdminRuntime {
  content: ContentService;
}

let cached: { base: KreizAdminRuntime; runtime: KreizContentRuntime } | null = null;

export function getKreizContentRuntime(): KreizContentRuntime {
  const base = getKreizAdminRuntime();
  if (cached?.base !== base) {
    const content = createContentService({
      entries: createContentEntriesRepository(base.db),
      audit: createAdminAuditLogRepository(base.db),
      registry: getContentRegistry(),
    });
    cached = { base, runtime: { ...base, content } };
  }
  return cached.runtime;
}
