import type {
  RebuildRequestReason,
  RebuildTrigger,
  RebuildTriggerResult,
} from '../../src/ports/rebuild';

/**
 * Déclencheur de rebuild **programnable** (mission §36) : enregistre chaque
 * appel (raison, ordre) et retourne le résultat configuré. Aucun réseau —
 * l'adapter HTTP réel est testé séparément contre un serveur local contrôlé.
 */
export type RebuildTriggerStub = RebuildTrigger & {
  /** Appels enregistrés, en ordre. */
  calls: Array<{ reason: RebuildRequestReason }>;
  /** Résultat à retourner pour le prochain appel (défault : succès). */
  nextResult: RebuildTriggerResult;
};

export function createRebuildTriggerStub(
  initialResult: RebuildTriggerResult = { ok: true, requestId: 'req-stub' },
): RebuildTriggerStub {
  const stub: RebuildTriggerStub = {
    calls: [],
    nextResult: initialResult,
    async requestRebuild(input) {
      stub.calls.push({ reason: input.reason });
      return stub.nextResult;
    },
  };
  return stub;
}
