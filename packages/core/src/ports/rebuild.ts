/**
 * Port de reconstruction du site (cadrage §5, §6, mission §8) — contrat du
 * domaine de publication. Le service de publication connaît uniquement cette
 * interface : aucune URL Vercel, aucun webhook, aucune API plateforme
 * (Cloudflare, Netlify, GitHub Actions) ne fuit dans le domaine.
 *
 * Sémantique **honnête** (mission §40) : un déclencheur de rebuild ne donne
 * qu'un **accusé de réception** — « rebuild *requested* », jamais « rebuild
 * *succeeded* ». Le provider (Vercel) build asynchronement : le résultat du
 * build n'est pas connu ici, et le dernier déploiement valide reste servi
 * tant que le nouveau n'a pas réussi (déploiements atomiques, cadrage §9).
 *
 * Trois états distingués (mission §10) :
 * - `ok` — le provider a accepté la demande ;
 * - `not-configured` — **aucun adapter configuré** : état normal (un projet
 *   peut piloter son déploiement autrement), signalé à l'admin, jamais une
 *   erreur ;
 * - `unreachable` / `rejected` — erreur temporaire ou refus du provider :
 *   la DB (source éditoriale) reste dans son nouvel état, le site public
 *   reste inchangé, l'admin reçoit une erreur explicite et peut relancer.
 */

/** Ce qui a motivé la demande de reconstruction — trace d'audit, pas d'API provider. */
export type RebuildRequestReason =
  | 'content.published'
  | 'content.unpublished'
  | 'content.deleted'
  | 'manual';

/** Résultat typé d'une demande de reconstruction — jamais la réponse brute du provider (mission §35). */
export type RebuildTriggerResult =
  | { ok: true; /** Identifiant provider éventuel — absent si le provider n'en fournit pas. */ requestId: string | null }
  | { ok: false; failure: RebuildTriggerFailure };

export type RebuildTriggerFailure =
  /** Aucun adapter configuré — publication réussie, site non reconstruit automatiquement. */
  | { kind: 'not-configured' }
  /** Le provider n'a pas pu être contacté (réseau, timeout). */
  | { kind: 'unreachable' }
  /** Le provider a refusé la demande (statut HTTP non 2xx). */
  | { kind: 'rejected'; statusCode: number };

export interface RebuildTrigger {
  /**
   * Demande la reconstruction du site public. Idempotent côté provider
   * (mission §34) : des déclenchements rapprochés sont coalescés par la
   * plateforme — aucune deduplication applicative en V1.
   */
  requestRebuild(input: { reason: RebuildRequestReason }): Promise<RebuildTriggerResult>;
}

/**
 * Déclencheur **absent** — utilisé quand aucun provider n'est configuré :
 * `not-configured` est un premier-class result, pas une exception, pour que
 * publish/unpublish/delete réussissent et soient audités honnêtement.
 */
export function createNoopRebuildTrigger(): RebuildTrigger {
  return {
    async requestRebuild() {
      return { ok: false, failure: { kind: 'not-configured' } } satisfies RebuildTriggerResult;
    },
  };
}
