/**
 * Vocabulaire d'audit du domaine média (mission §44) — actions stables,
 * metadata minimales. Invariant d'honnêteté de l'acteur (revue slice 2) :
 * les événements de **processing système** portent `actor_admin_id = NULL`
 * avec `metadata.source: 'background_job' | 'recovery' | 'confirm'` —
 * jamais un admin attribué par erreur.
 */
export const MEDIA_AUDIT_ACTIONS = {
  created: 'media.created',
  ready: 'media.ready',
  failed: 'media.failed',
  retried: 'media.retried',
  altUpdated: 'media.alt_updated',
  deleted: 'media.deleted',
} as const;

/** Sources d'audit système — l'acteur réel est toujours distingué. */
export type MediaAuditSource = 'confirm' | 'background_job' | 'recovery';
