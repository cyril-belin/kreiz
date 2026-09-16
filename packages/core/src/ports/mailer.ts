/**
 * Port d'envoi d'email (cadrage §13) — contrat **minimal** du domaine
 * formulaires. Le service de contact connaît uniquement cette interface :
 * aucune API Resend/SMTP/SESend ne fuit dans le domaine (principe §2.5).
 *
 * Sémantique alignée sur le port `RebuildTrigger` (mission §40 —
 * honnêteté des résultats) :
 * - `ok: true` — le transport a accepté le message (`messageId` éventuel) ;
 * - `ok: false, unreachable` — transport injoignable (réseau, timeout) ;
 * - `ok: false, rejected` — transport injoignable au sens refuse : statut
 *   HTTP non 2xx (`statusCode` porté, **jamais** la réponse brute).
 *
 * La livraison est **at-least-once** : un crash entre l'envoi et la
 * persistance de `sent` peut provoquer un doublon côté destinataire —
 * conséquence assumée, documentée, et préférée à la perte d'une
 * notification. L'échec n'est **jamais** une perte : la demande reste
 * stockée et relançable depuis l'admin.
 *
 * Aucun fournisseur n'est imposé : sans `Mailer` configuré, la demande est
 * stockée, marquée `not_configured`, et visible dans l'admin. L'adapter de
 * référence V1 (`adapters/mailer/webhook.ts`) relaie le message préparé
 * vers une URL contrôlée par le Project — le wiring vers Resend, SMTP ou
 * tout autre service se fait derrière ce même port sans toucher au domaine.
 */

export interface MailAddress {
  email: string;
  /** Nom d'affichage optionnel (jeton sûr — jamais interprété comme adresse). */
  name?: string;
}

export interface OutgoingEmail {
  /** Expéditeur d'enveloppe — configuration serveur, jamais une entrée visiteur. */
  from: MailAddress;
  /** Destinataires — issus de la déclaration en code du formulaire. */
  to: MailAddress[];
  /** Réponse adressée à l'expéditeur humain — adresse validée, ou `null`. */
  replyTo: MailAddress | null;
  /** Sujet — déclaré en code, sans caractère de contrôle. */
  subject: string;
  /** Corps texte brut — seule forme canonique V1 (aucun HTML visité). */
  text: string;
}

export type MailerSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; failure: { kind: 'unreachable' } | { kind: 'rejected'; statusCode: number } };

export interface Mailer {
  /**
   * Envoie un message préparé. Une seule tentative **par appel** : la
   * politique de re-tentatives (backoff, plafond, relance admin) appartient
   * au service, pas au transport.
   */
  send(email: OutgoingEmail): Promise<MailerSendResult>;
}
