import type { BackgroundJobs } from '../ports/jobs.js';

/**
 * Adapter **jobs d'arrière-plan** — composition à base d'un planificateur
 * (mission §17/§18/§19). Le handler appartient à la composition racine : il
 * appelle le service de traitement média ; l'adapter ne connaît ni la base
 * ni Sharp.
 *
 * Deux planificateurs de référence :
 * - **Vercel** : `waitUntil` du contexte serverless — le traitement continue
 *   après la réponse HTTP (mission §18), `waitUntil` reste confiné ici
 *   (cadrage §11) ;
 * - **serveur long-lived (dev)** : fire-and-forget — la promesse vit dans le
 *   processus Node, sans bloquer la réponse (jamais `await` dans la requête).
 *
 * Tests : une file contrôlée (mission §19) est fournie par les helpers de
 * test — aucun service de queue réel n'est jamais requis.
 */
export function createScheduledBackgroundJobs(options: {
  /** Résout l'action à exécuter pour un média (ex. `processMedia`). */
  handler: (mediaId: string) => Promise<void>;
  /**
   * Planifie l'exécution — `waitUntil` (Vercel) ou fire-and-forget (dev).
   * Ne lève jamais : une erreur de planification ne doit pas faire échouer
   * la requête confirm (le média reste `processing`, récupérable).
   */
  schedule: (task: () => Promise<void>) => void;
}): BackgroundJobs {
  return {
    async enqueueMediaProcessing(mediaId: string) {
      options.schedule(() => options.handler(mediaId));
    },
  };
}

/** Planificateur `waitUntil` — contexte serverless Vercel. */
export function waitUntilScheduler(waitUntil: (promise: Promise<unknown>) => void): (task: () => Promise<void>) => void {
  return (task) => {
    waitUntil(
      task().catch(() => {
        // Le handler (service de traitement) journalise déjà son échec
        // (media → failed + audit) : l'erreur est consommée ici pour ne
        // pas remonter comme rejeton non géré du runtime.
      }),
    );
  };
}

/** Planificateur fire-and-forget — serveur dev/long-lived. */
export function fireAndForgetScheduler(): (task: () => Promise<void>) => void {
  return (task) => {
    void task().catch(() => {
      // Idem : l'échec applicatif est déjà matérialisé (media failed + audit).
    });
  };
}
