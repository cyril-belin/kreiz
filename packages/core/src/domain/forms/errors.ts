/**
 * Erreurs du domaine formulaires — codes **stables** (observables par les
 * tests et les routes) + messages français prêts à afficher, même contrat
 * que le rich text (slice 6). Aucune donnée utilisateur ne voyage dans un
 * message d'erreur système.
 */

export type ContactSubmissionErrorCode =
  /** Honeypot rempli ou remplissage anormalement rapide — réponse identique à un succès (jamais d'indice au bot). */
  | 'spam-signal'
  /** Jeton d'émission absent, mal formé, mal signé, d'un autre formulaire ou expiré. */
  | 'invalid-token'
  /** Rate limiting dépassé (hash d'IP × formulaire). */
  | 'rate-limited'
  /** Payload invalide — `fieldErrors` porte le détail par champ. */
  | 'invalid-payload'
  /** Payload trop volumineux (borne anti-abus). */
  | 'payload-too-large'
  /**
   * Soumission en double — même contenu, même client, même fenêtre
   * temporelle : idempotence, jamais une erreur visible de l'expéditeur.
   */
  | 'duplicate';

export class ContactSubmissionError extends Error {
  readonly code: ContactSubmissionErrorCode;
  readonly fieldErrors: Record<string, string> | null;
  /** Secondes avant nouvelle tentative — `rate-limited` uniquement. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: ContactSubmissionErrorCode,
    options: { message?: string; fieldErrors?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(options.message ?? `@kreiz/core : soumission refusée (${code}).`);
    this.name = 'ContactSubmissionError';
    this.code = code;
    this.fieldErrors = options.fieldErrors ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export type FormTokenErrorReason =
  | 'malformed'
  | 'bad-signature'
  | 'wrong-form'
  | 'expired'
  | 'unsigned';

/** Message utilisateur du rejet de jeton — sans détail exploitable. */
export function formTokenUserMessage(): string {
  return 'Ce formulaire a expiré ou n’est pas valide. Rechargez la page puis renvoyez votre message.';
}

/** Message utilisateur du dépassement de rate limiting. */
export function contactRateLimitedUserMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Trop de messages envoyés depuis votre connexion. Réessayez dans environ ${minutes} minute${minutes > 1 ? 's' : ''}.`;
}
