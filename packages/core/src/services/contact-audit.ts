import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';

/**
 * Vocabulaire d'audit du domaine contact — même discipline que les médias
 * (mission §44) : actions stables, metadata minimales, honnêteté de
 * l'acteur. Les événements **publics** (soumission, échec de notification,
 * balayage) portent `actor_admin_id = NULL` — jamais un admin attribué par
 * erreur. Les metadata ne portent **aucune donnée visiteur** : clé du
 * formulaire, état, kind d'échec — le payload reste dans la demande seule.
 */
export const CONTACT_AUDIT_ACTIONS = {
  submitted: 'contact.submitted',
  statusChanged: 'contact.status_changed',
  notificationRetried: 'contact.notification_retried',
  notificationFailed: 'contact.notification_failed',
} as const;

export type ContactAuditSource = 'submission' | 'admin' | 'recovery';

/** Événement système d'échec de notification — partagé par soumission, relance et balayage. */
export async function auditContactNotificationFailed(
  audit: Pick<AdminAuditLogRepository, 'append'>,
  options: {
    requestId: string;
    formKey: string;
    attempt: number;
    failureKind: 'unreachable' | 'rejected';
    source: ContactAuditSource;
    actorAdminId: string | null;
  },
): Promise<void> {
  await audit.append({
    actorAdminId: options.actorAdminId,
    action: CONTACT_AUDIT_ACTIONS.notificationFailed,
    entityType: 'contact_request',
    entityId: options.requestId,
    metadata: {
      form: options.formKey,
      attempt: options.attempt,
      failure: options.failureKind,
      source: options.source,
    },
  });
}
