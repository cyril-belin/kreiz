import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type { RebuildRequestReason, RebuildTriggerFailure } from '../ports/rebuild.js';

/**
 * Audit des échecs de reconstruction — partagé par le service contenu
 * (suppression d'un publié) et le service de publication. Évite tout cycle
 * d'import entre les deux services.
 *
 * Événement `site.rebuild_failed` : l'acteur est l'admin ayant déclenché
 * l'opération (invariant d'honnêteté du slice 2). Les métadonnées portent
 * le `kind` d'échec et le statut HTTP éventuel — **jamais** la réponse
 * brute du provider ni l'URL du hook (mission §16, §49).
 */
export async function auditRebuildFailure(
  audit: Pick<AdminAuditLogRepository, 'append'>,
  actorAdminId: string,
  operation: RebuildRequestReason,
  failure: RebuildTriggerFailure,
): Promise<void> {
  await audit.append({
    actorAdminId,
    action: 'site.rebuild_failed',
    entityType: 'site',
    entityId: 'rebuild',
    metadata: {
      operation,
      failure: failure.kind,
      ...(failure.kind === 'rejected' ? { statusCode: failure.statusCode } : {}),
    },
  });
}
