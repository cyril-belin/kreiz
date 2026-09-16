export const prerender = false;

import type { APIRoute } from 'astro';
import {
  ADMIN_FORMS_PATH,
  adminFormDetailPath,
} from '../../http/admin-routes.js';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import { getContactFormRegistry } from '../../forms/runtime.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Relance de la notification email d'une demande de contact — mutation
 * POST progressive (guard session + CSRF + same-site). La demande est
 **jamais** modifiée par la relance : seule la notification est retentée ;
 * un échec reste un échec tracé, la demande reste intacte.
 */
function redirect(location: string, prod: boolean): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, ...adminSecurityHeaders({ prod }) },
  });
}

function forbidden(prod: boolean): Response {
  return new Response('Requête refusée.', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...adminSecurityHeaders({ prod }) },
  });
}

export const POST: APIRoute = async (ctx) => {
  const prod = import.meta.env.PROD;
  const runtime = getKreizContentRuntime();
  const sessionToken = sessionTokenFromCookies(ctx.cookies);

  if (!sessionToken) {
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect('/admin/login', prod);
  }
  if (!isTrustedSameSiteMutation(ctx.request)) {
    return forbidden(prod);
  }
  let formData: FormData;
  try {
    formData = await ctx.request.formData();
  } catch {
    return forbidden(prod);
  }
  const csrfSubmitted = formData.get(CSRF_FORM_FIELD);
  if (!verifySessionCsrfToken(sessionToken, typeof csrfSubmitted === 'string' ? csrfSubmitted : null)) {
    return forbidden(prod);
  }
  const access = await runtime.auth.resolveSession(sessionToken);
  if (access.status !== 'authenticated') {
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect('/admin/login', prod);
  }

  if (!runtime.mailer || !runtime.mailFrom) {
    return redirect(`${adminFormDetailPath(ctx.params.id ?? '')}?notify=unconfigured`, prod);
  }

  const requestId = ctx.params.id ?? '';
  const request = await runtime.contact.getRequest(requestId);
  if (!request) {
    return redirect(`${adminFormDetailPath(requestId)}?notify=missing`, prod);
  }
  const form = getContactFormRegistry().findByKey(request.formId);
  if (!form) {
    return redirect(`${adminFormDetailPath(requestId)}?notify=unconfigured`, prod);
  }

  const outcome = await runtime.contact.retryNotification({
    requestId,
    form,
    actorAdminId: access.admin.id,
  });
  if (!outcome) {
    return redirect(`${adminFormDetailPath(requestId)}?notify=missing`, prod);
  }
  return redirect(
    `${adminFormDetailPath(requestId)}?notify=${outcome.status === 'sent' ? 'sent' : 'failed'}`,
    prod,
  );
};

export const GET: APIRoute = async () => {
  return new Response(null, { status: 303, headers: { Location: ADMIN_FORMS_PATH } });
};
