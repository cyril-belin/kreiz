import type { KreizMediaStatus } from '../../data/tables/media.js';

/**
 * Machine à états du cycle de vie média (mission §2, §11, §22 ; cadrage
 * §11) — règles pures, aucune I/O.
 *
 * ```text
 * uploading ──confirm ok──▶ processing ──transform ok──▶ ready (terminal)
 *     │                          │
 *     └──validation refusée──▶ failed ◀──transform échoué──┘
 *                                  │
 *                                  └──retry admin/récupération──▶ processing
 * ```
 *
 * - `ready` est **terminal** : les variantes sont publiques et servies avec
 *   `immutable` — un média ready n'est jamais retransformé (aucun remplacement
 *   silencieux d'objet à la même URL, mission §40).
 * - `failed → processing` : uniquement via le retry admin (audit
 *   `media.retried`) ou la récupération explicite — pas de retry infini
 *   automatique (mission §22).
 * - Les transitions sont gardées **en base** par le repository
 *   (`UPDATE … WHERE status IN (…)` — sûreté sous double confirmation
 *   concurrente, mission §11) ; cette table fait foi côté domaine.
 */

export const MEDIA_STATUS_TRANSITIONS: Readonly<
  Record<KreizMediaStatus, readonly KreizMediaStatus[]>
> = {
  uploading: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: ['processing'],
};

export function canTransitionMediaStatus(from: KreizMediaStatus, to: KreizMediaStatus): boolean {
  return MEDIA_STATUS_TRANSITIONS[from].includes(to);
}
