import { createHmac, timingSafeEqual } from 'node:crypto';
import { FORM_TOKEN_MAX_AGE_SECONDS } from './policy.js';

/**
 * Jeton d'émission du formulaire public (FIT — *form issuance token*).
 *
 * **Ce que le jeton prouve** : le visiteur a reçu une vraie page HTML de ce
 * site (rendue par le build statique ou par un re-rendu serveur). Il ne
 * porte aucun secret et n'identifie personne : `formKey` + instant
 * d'émission, authentifiés par HMAC-SHA256 (`KREIZ_SECRET`).
 *
 * **Ce qu'il permet de refuser** :
 * - les bots qui POSTent l'endpoint à l'aveugle, sans jamais avoir chargé
 *   la page (pas de jeton / signature invalide) ;
 * - le replay illimité de jetons récoltés sur un vieux build (âge maximal)
 *   ou « expédiés » avant tout remplissage humain (âge minimal) ;
 * - la falsification de l'instant d'émission par le client (signature).
 *
 * **Dégradation explicite** : si `KREIZ_SECRET` est absent au rendu
 * (build de fork sans secrets), le jeton est émis non signé (`v1u`) et le
 * service le **rejettera** — un déploiement sans secret est un
 * déploiement cassé (l'admin et le rate limiting exigent le même secret) ;
 * le formulaire ne fait pas semblant de fonctionner.
 */

const TOKEN_VERSION_SIGNED = 'v1';
const TOKEN_VERSION_UNSIGNED = 'v1u';
const HMAC_LABEL = 'kreiz:contact-form-token:v1';

export type FormToken = string;

export interface IssuedFormToken {
  token: FormToken;
  /** Instant d'émission (seconde de précision — porté dans le jeton). */
  issuedAt: Date;
  /** `false` = émis sans secret : le service rejettera toute soumission. */
  signed: boolean;
}

function encodePayload(formKey: string, issuedAtSeconds: number): string {
  return Buffer.from(`${formKey}|${issuedAtSeconds}`, 'utf8').toString('base64url');
}

function decodePayload(payload: string): { formKey: string; issuedAtSeconds: number } | null {
  const raw = Buffer.from(payload, 'base64url').toString('utf8');
  const separator = raw.lastIndexOf('|');
  if (separator <= 0) return null;
  const formKey = raw.slice(0, separator);
  const seconds = Number(raw.slice(separator + 1));
  if (!formKey || !Number.isInteger(seconds) || seconds < 0) return null;
  return { formKey, issuedAtSeconds: seconds };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', `${HMAC_LABEL}:${secret}`).update(payload).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Émet un jeton pour un rendu de formulaire (build statique ou re-rendu
 * serveur). `reissueIssuedAt` permet au re-rendu d'erreurs de **conserver
 * l'instant d'émission d'origine** (jeton valide reçu) : le temps de
 * remplissage continue de croître au lieu de repartir de zéro — la correction
 * d'une erreur de frappe n'est jamais rejetée comme « trop rapide ».
 */
export function issueFormToken(options: {
  formKey: string;
  issuedAt?: Date;
  secret: string | null | undefined;
  /** Instant d'un jeton valide déjà émis — re-signé tel quel. */
  reissueIssuedAt?: Date;
}): IssuedFormToken {
  const issuedAt = options.reissueIssuedAt ?? options.issuedAt ?? new Date();
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
  const payload = encodePayload(options.formKey, issuedAtSeconds);
  if (!options.secret) {
    return { token: `${TOKEN_VERSION_UNSIGNED}.${payload}.`, issuedAt, signed: false };
  }
  return { token: `${TOKEN_VERSION_SIGNED}.${payload}.${sign(payload, options.secret)}`, issuedAt, signed: true };
}

export type FormTokenVerification =
  | { ok: true; formKey: string; issuedAt: Date }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'wrong-form' | 'expired' | 'unsigned' };

/**
 * Vérifie un jeton soumis : structure, signature (temps constant),
 * formulaire ciblé, âge maximal. La borne **minimale** (temps de
 * remplissage) est appliquée par le service — elle produit un rejet
 * « spam-signal » silencieux, pas une erreur visible.
 */
export function verifyFormToken(
  token: string,
  options: { formKey: string; secret: string; now: Date },
): FormTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION_SIGNED) {
    return { ok: false, reason: version === TOKEN_VERSION_UNSIGNED ? 'unsigned' : 'malformed' };
  }
  const expected = sign(payload, options.secret);
  if (!constantTimeEquals(signature, expected)) return { ok: false, reason: 'bad-signature' };
  const decoded = decodePayload(payload);
  if (!decoded) return { ok: false, reason: 'malformed' };
  if (decoded.formKey !== options.formKey) return { ok: false, reason: 'wrong-form' };
  const issuedAt = new Date(decoded.issuedAtSeconds * 1000);
  const ageSeconds = (options.now.getTime() - issuedAt.getTime()) / 1000;
  if (ageSeconds > FORM_TOKEN_MAX_AGE_SECONDS) return { ok: false, reason: 'expired' };
  return { ok: true, formKey: decoded.formKey, issuedAt };
}

/**
 * Âge du jeton en secondes — calculé serveur uniquement (l'instant
 * d'émission vient du jeton signé, `now` de l'horloge serveur) : aucune
 * donnée temporelle soumise par le client n'est jamais crue.
 */
export function formTokenAgeSeconds(issuedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - issuedAt.getTime()) / 1000);
}
