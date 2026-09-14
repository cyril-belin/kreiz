import type {
  RebuildRequestReason,
  RebuildTrigger,
  RebuildTriggerResult,
} from '../../ports/rebuild.js';

/**
 * Adapter de référence du port `RebuildTrigger` — **deploy hook Vercel**
 * (cadrage §5, mission §9). Confiné à l'adapter : le service de publication
 * ne connaît ni Vercel ni cette URL.
 *
 * Sécurité du hook (mission §37) :
 * - l'URL vient de l'**environnement runtime** (`KREIZ_REBUILD_DEPLOY_HOOK_URL`
 *   validé dans `http/server-env.ts`) — jamais de la config client, jamais
 *   d'une saisie admin ;
 * - **HTTPS imposé en production** (relâché explicitement en dev/test pour
 *   un hook local `http://127.0.0.1`) ;
 * - l'URL n'est jamais logguée, jamais rendue dans le HTML, jamais incluse
 *   dans un message d'erreur ou un audit (les échecs portent un `kind` et un
 *   statut HTTP, jamais la réponse du provider).
 *
 * Le POST est un accusé d'envoi : Vercel lance le build asynchronement — le
 * résultat est « rebuild requested », pas « rebuild succeeded » (mission §40).
 */
export function createVercelDeployHookTrigger(options: {
  /** URL du deploy hook (secret porteur) — fournie par l'env runtime du Project. */
  hookUrl: string;
  /**
   * Autoriser `http://` (développement et tests contre un hook local).
   * Production : toujours `false` — un hook interceptable en clair permettrait
   * de déclencher des déploiements à volonté.
   */
  allowInsecureHttp: boolean;
  /** Injection pour les tests — défaut : fetch global. */
  fetchFn?: typeof fetch;
  /** Injection pour les tests — défaut : 10 s (une demande ne bloque pas l'admin). */
  timeoutMs?: number;
}): RebuildTrigger {
  let parsed: URL;
  try {
    parsed = new URL(options.hookUrl);
  } catch {
    throw new Error(
      '@kreiz/core : KREIZ_REBUILD_DEPLOY_HOOK_URL invalide — une URL absolue de deploy hook est attendue.',
    );
  }
  if (parsed.protocol !== 'https:' && !(options.allowInsecureHttp && parsed.protocol === 'http:')) {
    throw new Error(
      '@kreiz/core : KREIZ_REBUILD_DEPLOY_HOOK_URL doit utiliser HTTPS en production (hook de déploiement secret).',
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async requestRebuild(input: { reason: RebuildRequestReason }): Promise<RebuildTriggerResult> {
      let response: Response;
      try {
        response = await fetchFn(parsed, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Corps minimal — le provider ignore le contenu ; la charge utile
          // n'expose rien (l'URL du hook porte déjà le secret).
          body: JSON.stringify({ reason: input.reason, source: 'kreiz' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Erreur réseau/timeout : message assaini — ni l'URL ni la pile.
        return { ok: false, failure: { kind: 'unreachable' } };
      }
      if (!response.ok) {
        return { ok: false, failure: { kind: 'rejected', statusCode: response.status } };
      }
      // Les deploy hooks Vercel ne retournent pas d'identifiant exploitable :
      // `requestId: null` — on ne prétend pas un suivi qu'on n'a pas.
      return { ok: true, requestId: null };
    },
  };
}
