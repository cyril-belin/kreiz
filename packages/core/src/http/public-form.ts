import type { ContactFormDeclaration } from '../domain/forms/declaration.js';
import { contactHoneypotField } from '../domain/forms/declaration.js';
import type { ContactFieldErrors } from '../domain/forms/fields.js';
import { CONTACT_PAYLOAD_MAX_BYTES } from '../domain/forms/policy.js';
import { ContactSubmissionError } from '../domain/forms/errors.js';
import { issueFormToken, verifyFormToken } from '../domain/forms/token.js';
import { FORM_TOKEN_FIELD, publicFormSubmitPath } from '../domain/forms/policy.js';
import { renderContactFormHtml } from '../domain/forms/render.js';

/**
 * Parseur et orchestration HTTP de l'endpoint public de soumission
 * (`/api/forms/<key>` — hors `/admin`, jamais de session admin ici).
 *
 * Sécurité par **whitelist stricte** : seuls le jeton, le honeypot et les
 * champs déclarés sont lus. Toute autre entrée POSTée (champ inconnu, faux
 * `recipients`, `form_id`, tentative d'override d'enveloppe) est ignorée —
 * l'enveloppe email se construit exclusivement depuis la déclaration en code.
 *
 * Le format est celui d'un formulaire HTML classique
 * (`application/x-www-form-urlencoded` ou `multipart/form-data`) : aucun
 * JavaScript requis, aucune API JSON publique.
 */

export interface ParsedContactSubmission {
  /** Valeurs brutes des champs déclarés uniquement (trimmées). */
  values: Record<string, string | boolean>;
  /** Champ honeypot rempli. */
  honeypotFilled: boolean;
  /** Jeton d'émission soumis (chaîne vide si absent). */
  token: string;
  /** Entrées POST non déclarées — comptées (signal), jamais lues. */
  unexpectedFieldCount: number;
}

/** Parse un POST public — whitelist des champs déclarés, honeypot et jeton. */
export function parseContactSubmission(
  form: Pick<ContactFormDeclaration, 'fields' | 'honeypotField'>,
  formData: FormData,
): ParsedContactSubmission {
  const honeypot = contactHoneypotField(form);
  const values: Record<string, string | boolean> = {};
  let unexpectedFieldCount = 0;

  for (const [key, entry] of formData.entries()) {
    if (key === FORM_TOKEN_FIELD) {
      continue; // lu séparément, ci-dessous
    }
    if (key === honeypot) {
      continue; // détecté par présence, valeur jamais lue
    }
    const descriptor = form.fields[key];
    if (!descriptor) {
      unexpectedFieldCount += 1; // champ non déclaré : ignoré, jamais interprété
      continue;
    }
    if (descriptor.kind === 'consent') {
      values[key] = entry === 'true' || entry === 'on';
      continue;
    }
    if (typeof entry === 'string') {
      // Troncature défensive AVANT trim : une entrée de plusieurs mégaoctets
      // ne circule jamais dans le pipeline (la borne finale reste le schéma).
      values[key] = entry.slice(0, 100_000).trim();
    }
  }

  const tokenEntry = formData.get(FORM_TOKEN_FIELD);
  const token = typeof tokenEntry === 'string' ? tokenEntry : '';
  const honeypotEntry = formData.get(honeypot);
  const honeypotFilled = typeof honeypotEntry === 'string' && honeypotEntry.trim().length > 0;

  return { values, honeypotFilled, token, unexpectedFieldCount };
}

/** Vérifie la taille agrégée du payload avant validation (borne anti-abus). */
export function contactPayloadTooLarge(values: Record<string, string | boolean>): boolean {
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    total += key.length;
    total += typeof value === 'string' ? value.length : 4;
    if (total > CONTACT_PAYLOAD_MAX_BYTES) return true;
  }
  return false;
}

/** Re-rendu du formulaire avec valeurs et erreurs — jeton re-signé, **même instant d'émission**. */
export function renderContactFormWithErrors(options: {
  form: ContactFormDeclaration;
  submittedToken: string;
  secret: string;
  now: Date;
  values: Record<string, string | boolean>;
  fieldErrors: ContactFieldErrors;
  formError?: string | null;
}): string {
  return renderContactFormHtml({
    form: options.form,
    token: reissuedToken(options.form.key, options.submittedToken, options.secret, options.now),
    values: {
      values: options.values,
      fieldErrors: options.fieldErrors,
      formError: options.formError ?? null,
    },
  });
}

/**
 * Re-signe un jeton valide en conservant son instant d'émission : le temps
 * de remplissage continue de courir après une erreur de validation — la
 * correction d'une frappe n'est jamais rejetée comme « trop rapide ». Un
 * jeton invalide est remplacé par un jeton frais (le POST 403 ne passe
 * jamais par ici).
 */
function reissuedToken(formKey: string, submittedToken: string, secret: string, now: Date): string {
  const verification = verifyFormToken(submittedToken, { formKey, secret, now });
  if (verification.ok) {
    return issueFormToken({ formKey, secret, reissueIssuedAt: verification.issuedAt }).token;
  }
  return issueFormToken({ formKey, secret, issuedAt: now }).token;
}

/** Réponse 303 PRG vers la page de confirmation (jamais une URL visiteur). */
export function contactConfirmationRedirect(form: ContactFormDeclaration): Response {
  return new Response(null, {
    status: 303,
    headers: { location: form.confirmationPath },
  });
}

/**
 * Page HTML autonome de re-rendu (erreurs de validation, rate limit, jeton
 * invalide) — sémantique et lisible sans CSS : le Core ne livre pas de
 * feuille de style publique ; les classes `kz-*` sont des points d'ancrage
 * pour le Project. `noindex` : aucune page d'erreur n'est indexable.
 */
export function contactStandalonePage(options: {
  title: string;
  bodyHtml: string;
  status: number;
  retryAfterSeconds?: number;
}): Response {
  // Le titre est échappé **dans** le helper (revue sécurité finale) : les
  // appelants actuels ne passent que des constantes, mais un futur appelant
  // dérivant le titre d'une entrée visiteur ne doit pas pouvoir y injecter
  // du HTML sur cette page publique sans CSP.
  const safeTitle = options.title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${safeTitle}</title>
</head>
<body>
<main class="kz-form-page">
${options.bodyHtml}
</main>
</body>
</html>`;
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  if (options.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(options.retryAfterSeconds);
  }
  return new Response(html, { status: options.status, headers });
}

/** Lève l'erreur de payload surdimensionné (traduction HTTP côté route). */
export function assertContactPayloadSize(values: Record<string, string | boolean>): void {
  if (contactPayloadTooLarge(values)) {
    throw new ContactSubmissionError('payload-too-large');
  }
}

/** Chemin public de soumission (réexport lisible pour les routes et le Project). */
export { publicFormSubmitPath };
