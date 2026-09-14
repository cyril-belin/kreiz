import { getContentRegistry } from '../content/runtime.js';
import { createAdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import { createContentEntriesRepository } from '../data/repositories/content-entries.js';
import { createRedirectsRepository } from '../data/repositories/redirects.js';
import { createContentService, type ContentService } from '../services/content.js';
import { createPublicationService, type PublicationService } from '../services/publication.js';
import { getKreizAdminRuntime, type KreizAdminRuntime } from './server-env.js';

/**
 * Composition root des pages du moteur de contenu : runtime admin (base +
 * auth + port de rebuild) **plus** les services contenu et publication
 * construits sur le registre des types du Project (module virtuel).
 * Memoïsé par identité du runtime de base — une seule revalidation du
 * registre par processus.
 *
 * Ce module n'est importable que dans un contexte Vite/Astro (il tire le
 * module virtuel) : les services et tests injectent un registre explicite.
 */
export interface KreizContentRuntime extends KreizAdminRuntime {
  content: ContentService;
  publication: PublicationService;
}

let cached: { base: KreizAdminRuntime; runtime: KreizContentRuntime } | null = null;

export function getKreizContentRuntime(): KreizContentRuntime {
  const base = getKreizAdminRuntime();
  if (cached?.base !== base) {
    const entries = createContentEntriesRepository(base.db);
    const audit = createAdminAuditLogRepository(base.db);
    const redirects = createRedirectsRepository(base.db);
    const registry = getContentRegistry();
    const content = createContentService({ entries, audit, registry, rebuild: base.rebuild });
    const publication = createPublicationService({
      entries,
      redirects,
      audit,
      registry,
      rebuild: base.rebuild,
    });
    cached = { base, runtime: { ...base, content, publication } };
  }
  return cached.runtime;
}
