export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH } from '../../http/admin-routes.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Reconstruction manuelle du site — **mutation** POST authentifiée
 * (mission §13) : même port `RebuildTrigger`, même socle de garde
 * (session + same-site + CSRF) qu'une publication. Auditée
 * `site.rebuild_requested`. Sert au rétablissement après un échec de
 * trigger (le dernier site valide reste servi — rien n'est jamais détruit).
 *
 * `return_to` (optionnel) est restreint aux chemins `/admin/*` — jamais
 * d'ouverture à une redirection arbitraire.
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

function safeReturnTo(value: FormDataEntryValue | null): string {
  if (typeof value === 'string' && /^\/admin(\/|$)/.test(value) && !value.startsWith('//')) {
    return value;
  }
  return ADMIN_HOME_PATH;
}

export const POST: APIRoute = async (ctx) => {
  const prod = import.meta.env.PROD;
  const runtime = getKreizContentRuntime();
  const sessionToken = sessionTokenFromCookies(ctx.cookies);

  if (!sessionToken) {
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect(ADMIN_LOGIN_PATH, prod);
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
    return redirect(ADMIN_LOGIN_PATH, prod);
  }

  const returnTo = safeReturnTo(formData.get('return_to'));

  const { rebuild } = await runtime.publication.requestSiteRebuild({
    actorAdminId: access.admin.id,
  });

  const url = new URL(returnTo, 'http://k');
  url.searchParams.set(
    'rebuild',
    rebuild.ok ? 'ok' : rebuild.failure.kind === 'not-configured' ? 'unconfigured' : 'failed',
  );
  return redirect(`${url.pathname}${url.search}`, prod);
};

export const GET: APIRoute = async () => {
  // Aucun effet de bord par GET : retour au dashboard.
  return redirect(ADMIN_HOME_PATH, false);
};
