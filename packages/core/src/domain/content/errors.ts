/**
 * Erreurs de domaine du moteur de contenu (cadrage §6 — couche domain).
 *
 * Chaque classe correspond à une situation métier précise : la couche HTTP
 * les traduit en réponses propres (404, 409…) sans jamais exposer SQL,
 * stack trace, payload interne ni configuration du Project (mission §27).
 */

/** Base commune — permet aux routes de distinguer les erreurs du moteur. */
export class KreizContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * La clé de type demandée (URL, route, contenu stocké) ne correspond à
 * aucune déclaration du registre — jamais rendue comme du contenu valide.
 */
export class UnknownContentTypeError extends KreizContentError {
  readonly key: string;
  constructor(key: string) {
    super(`@kreiz/core : type de contenu inconnu « ${key} » — aucune déclaration correspondante.`);
    this.key = key;
  }
}

/**
 * Une entrée en base référence un type non déclaré ou des données invalides
 * pour le schéma de son type : on ne rend pas silencieusement du contenu
 * invalide (mission §4).
 */
export class ContentDataCorruptedError extends KreizContentError {
  readonly entryId: string;
  readonly reason: string;
  constructor(entryId: string, reason: string) {
    super(`@kreiz/core : données du contenu ${entryId} invalides — ${reason}`);
    this.entryId = entryId;
    this.reason = reason;
  }
}

/** Contenu introuvable (ou référencé sous un mauvais type de route). */
export class ContentNotFoundError extends KreizContentError {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`@kreiz/core : contenu introuvable (${entryId}).`);
    this.entryId = entryId;
  }
}

/** Opération sur un contenu déjà soft-deleted. */
export class ContentDeletedError extends KreizContentError {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`@kreiz/core : contenu déjà supprimé (${entryId}).`);
    this.entryId = entryId;
  }
}

/**
 * **Concurrence optimiste** (passe de fermeture) : le Save portait une
 * version (`expected_updated_at`) qui ne correspond plus à la ligne — un
 * autre administrateur a enregistré entre-temps. L'UPDATE conditionnel n'a
 * modifié **aucune** ligne : jamais d'écrasement silencieux. L'admin
 * recharge la page et reporte sa modification.
 */
export class ContentConcurrentModificationError extends KreizContentError {
  readonly entryId: string;
  constructor(entryId: string) {
    super(
      `@kreiz/core : contenu modifié entre-temps par un autre administrateur (${entryId}) — rechargez la page pour récupérer la version à jour avant d'enregistrer.`,
    );
    this.entryId = entryId;
  }
}

/**
 * Publication refusée : un chemin public du contenu (l'ancien, que la
 * redirection masquerait — mission §19, cadrage §12 « ancien slug réapparu =
 * conflit détecté » — ou le **nouveau**, déjà figé par un autre contenu
 * publié vivant dans le même namespace — revue sécurité finale) est
 * actuellement occupé par un **autre** contenu. La publication échoue
 * **avant** toute écriture, ou est arbitrée par l'index unique partiel
 * `published_path_active_key` en cas de course ; l'admin résout en
 * changeant le slug de l'un des deux contenus.
 */
export class PublishedPathOccupiedError extends KreizContentError {
  readonly entryId: string;
  readonly occupiedPath: string;
  constructor(entryId: string, occupiedPath: string) {
    super(
      `@kreiz/core : publication impossible — l'adresse publique ${occupiedPath} est actuellement utilisée par un autre contenu (entrée ${entryId}).`,
    );
    this.entryId = entryId;
    this.occupiedPath = occupiedPath;
  }
}

/**
 * Garde défensive du moteur de redirections : un plan d'écriture ne crée
 * jamais d'auto-redirection (une page ne redirecte pas vers elle-même).
 */
export class RedirectSelfPathError extends KreizContentError {
  readonly path: string;
  constructor(path: string) {
    super(`@kreiz/core : redirection de ${path} vers lui-même interdite — boucle détectée.`);
    this.path = path;
  }
}
