/**
 * Port de jobs d'arrière-plan (mission §17 ; cadrage §5, §11) — abstraction
 * minimale : le domaine média demande l'exécution **asynchrone** du
 * traitement d'un média, sans connaître aucune queue.
 *
 * - Adapter Vercel de référence : `waitUntil` — le travail continue après la
 *   réponse HTTP, **confoné à l'adapter** (cadrage §11, mission §18) ;
 * - adapter dev/in-memory : file contrôlée (tests) ou exécution
 *   fire-and-forget (serveur long-lived local) — mission §19 ;
 * - pas de file durable en V1 : la récupération des jobs perdus passe par
 *   les services `retryFailedMedia` / `processStuckMedia` (mission §20),
 *   appelables par un cron futur.
 */
export interface BackgroundJobs {
  /** Planifie la transformation asynchrone d'un média confirmé. */
  enqueueMediaProcessing(mediaId: string): Promise<void>;
}
