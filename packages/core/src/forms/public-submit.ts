export const prerender = false;

import type { APIRoute } from 'astro';
import { getContactFormRegistry } from './runtime.js';
import { getKreizContentRuntime } from '../http/admin-runtime.js';
import { formTokenUserMessage } from '../domain/forms/errors.js';
import {
  assertContactPayloadSize,
  contactConfirmationRedirect,
  contactStandalonePage,
  parseContactSubmission,
  renderContactFormWithErrors,
} from '../http/public-form.js';
import { isTrustedSameSiteMutation } from '../http/mutations.js';
import { clientIpFromHeaders } from '../http/admin-login.js';
import { analyticsPageFromReferer } from '../analytics/collect.js';

/**
 * Endpoint public de soumission — `/api/forms/[key]` (cadrage §5 : les
 * endpoints dynamiques du public sont des fonctions serveur ; hors `/admin`,
 * **jamais** de session admin ici).
 *
 * Comportements :
 * - `POST` — orchestration complète : same-site → parse whitelist → service
 *   (honeypot, rate limit, jeton, validation, idempotence, notification) ;
 *   succès ET double soumission → 303 page de remerciement (PRG) ; signal
 *   de bot → 303 identique (silence) ; erreurs utilisateur → re-rendu du
 *   formulaire (422/429/403) avec valeurs conservées.
 * - `GET` — 405 : le formulaire est rendu par la page publique du Project,
 *   pas par cet endpoint.
 *
 * Un formulaire non déclaré est un 404 sec : la clé n'est jamais une donnée
 * d'enveloppe, seulement une résolution de registre.
 */
export const POST: APIRoute = async (ctx) => {
  const runtime = getKreizContentRuntime();

  // Défense en profondeur anti-CSRF, AVANT toute résolution : Astro 403
  // déjà les POST cross-origin (checkOrigin) ; ce test local couvre les
  // content-types hors périmètre et interdit l'énumération des clés de
  // formulaires depuis l'extérieur.
  if (!isTrustedSameSiteMutation(ctx.request)) {
    return contactStandalonePage({
      title: 'Requête refusée',
      bodyHtml: '<p class="kz-form__error">Requête refusée.</p>',
      status: 403,
    });
  }

  const formKey = ctx.params.key ?? '';
  const registry = getContactFormRegistry();
  const form = registry.findByKey(formKey);
  if (!form) {
    return new Response('Formulaire introuvable.', { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await ctx.request.formData();
  } catch {
    return contactStandalonePage({
      title: 'Requête invalide',
      bodyHtml: '<p class="kz-form__error">Requête invalide.</p>',
      status: 400,
    });
  }

  const parsed = parseContactSubmission(form, formData);
  try {
    assertContactPayloadSize(parsed.values);
  } catch {
    return contactStandalonePage({
      title: 'Message trop volumineux',
      bodyHtml: '<p class="kz-form__error">Message trop volumineux — raccourcissez le texte et renvoyez.</p>',
      status: 422,
    });
  }

  const outcome = await runtime.contact.submit({
    form,
    values: parsed.values,
    honeypotFilled: parsed.honeypotFilled,
    token: parsed.token,
    clientIp: clientIpFromHeaders(ctx.request.headers),
    analyticsPage: analyticsPageFromReferer(ctx.request),
  });

  switch (outcome.kind) {
    case 'submitted':
    case 'duplicate':
    case 'spam-signal': {
      // PRG vers la page de remerciement. Le signal de bot reçoit la même
      // réponse qu'un succès : aucun indice, aucune ligne en base.
      return contactConfirmationRedirect(form);
    }
    case 'invalid-payload': {
      return contactStandalonePage({
        title: 'Vérifiez votre message',
        bodyHtml: renderContactFormWithErrors({
          form,
          submittedToken: parsed.token,
          secret: runtime.secret,
          now: new Date(),
          values: parsed.values,
          fieldErrors: outcome.fieldErrors,
        }),
        status: 422,
      });
    }
    case 'rate-limited': {
      return contactStandalonePage({
        title: 'Trop de messages',
        bodyHtml: `<p class="kz-form__error">${escapeText(runtime.contact.rateLimitedMessage(outcome.retryAfterSeconds))}</p>`,
        status: 429,
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }
    case 'invalid-token': {
      return contactStandalonePage({
        title: 'Formulaire expiré',
        bodyHtml: `<p class="kz-form__error">${escapeText(formTokenUserMessage())}</p>`,
        status: 403,
      });
    }
  }
};

export const GET: APIRoute = async () => {
  return new Response('Méthode non autorisée.', { status: 405 });
};

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
