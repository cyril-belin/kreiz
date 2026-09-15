/**
 * Erreurs de domaine médias (cadrage §6 — couche domain). Même contrat que
 * les erreurs contenu : la couche HTTP les traduit en réponses propres sans
 * jamais exposer SQL, stack trace, payload interne ni configuration.
 */

/** Base commune — permet aux routes de distinguer les erreurs du domaine média. */
export class KreizMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Un média non `ready` a été demandé comme média public (vue de template,
 * publication, build). Le public ne voit jamais `uploading`/`processing`/
 * `failed` (mission §2, §29).
 */
export class MediaNotReadyError extends KreizMediaError {
  readonly mediaId: string;
  constructor(mediaId: string, status: string) {
    super(
      `@kreiz/core : le média ${mediaId} n'est pas prêt (statut « ${status} ») — seuls les médias « ready » sont rendus publiquement.`,
    );
    this.mediaId = mediaId;
  }
}

/** Média introuvable ou déjà supprimé pour l'opération demandée. */
export class MediaNotFoundError extends KreizMediaError {
  readonly mediaId: string;
  constructor(mediaId: string) {
    super(`@kreiz/core : média introuvable (${mediaId}).`);
    this.mediaId = mediaId;
  }
}

/**
 * Suppression refusée : le média est référencé comme couverture par au
 * moins un contenu (y compris soft-deleted — l'historique éditorial prime,
 * mission §26/§46). L'admin retire d'abord la couverture du contenu.
 */
export class MediaInUseError extends KreizMediaError {
  readonly mediaId: string;
  /** Nombre de contenus (tous états, y compris soft-deleted) référençant le média. */
  readonly referenceCount: number;
  constructor(mediaId: string, referenceCount: number) {
    super(
      `@kreiz/core : média ${mediaId} utilisé comme couverture par ${referenceCount} contenu(s) — suppression refusée.`,
    );
    this.mediaId = mediaId;
    this.referenceCount = referenceCount;
  }
}

/**
 * Transition d'état interdite (ex. retry d'un média `ready`, confirmation
 * d'un média `failed`) — la machine à états fait foi.
 */
export class MediaStateError extends KreizMediaError {
  readonly mediaId: string;
  readonly status: string;
  constructor(mediaId: string, status: string, action: string) {
    super(
      `@kreiz/core : opération « ${action} » impossible sur un média ${mediaId} en statut « ${status} ».`,
    );
    this.mediaId = mediaId;
    this.status = status;
  }
}
