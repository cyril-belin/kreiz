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
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Transition d'état d'une demande de contact (`new` ⇄ `handled`) —
 * mutation POST progressive (guard session + CSRF + same-site), même socle
 * que les autres mutations admin. Auditée par le service au nom de l'admin.
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
  // Le body d'une requête ne se lit qu'une fois : formData est capturé ici
  // et réutilisé pour le CSRF et la valeur.
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

  const requestId = ctx.params.id ?? '';
  const statusRaw = formData.get('status');
  const status = statusRaw === 'handled' ? 'handled' : statusRaw === 'new' ? 'new' : null;
  if (!status) {
    return redirect(`${adminFormDetailPath(requestId)}?status=invalid`, prod);
  }

  const updated = await runtime.contact.markStatus({
    requestId,
    status,
    actorAdminId: access.admin.id,
  });
  if (!updated) {
    return redirect(`${ADMIN_FORMS_PATH}?missing=1`, prod);
  }
  return redirect(`${adminFormDetailPath(requestId)}?status=1`, prod);
};

export const GET: APIRoute = async () => {
  // Mutation interdite par GET : retour à la boîte, sans effet.
  return new Response(null, { status: 303, headers: { Location: ADMIN_FORMS_PATH } });
};
