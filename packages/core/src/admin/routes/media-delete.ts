export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_MEDIA_PATH } from '../../http/admin-routes.js';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Suppression d'un média (mission §26) — mutation POST progressive :
 * référencé comme couverture (même par un contenu soft-deleted) → refus
 * explicite avec message ; non référencé → suppression DB + objets
 * storage. GET sans effet de bord.
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
  let csrfSubmitted: FormDataEntryValue | null;
  try {
    csrfSubmitted = (await ctx.request.formData()).get(CSRF_FORM_FIELD);
  } catch {
    return forbidden(prod);
  }
  if (!verifySessionCsrfToken(sessionToken, typeof csrfSubmitted === 'string' ? csrfSubmitted : null)) {
    return forbidden(prod);
  }
  const access = await runtime.auth.resolveSession(sessionToken);
  if (access.status !== 'authenticated') {
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect('/admin/login', prod);
  }

  if (!runtime.mediaAdmin) {
    return redirect(`${ADMIN_MEDIA_PATH}?delete=not-configured`, prod);
  }

  const mediaId = ctx.params.id ?? '';
  try {
    await runtime.mediaAdmin.deleteMedia({ mediaId, actorAdminId: access.admin.id });
    return redirect(`${ADMIN_MEDIA_PATH}?delete=1`, prod);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'MediaNotFoundError') {
      return redirect(`${ADMIN_MEDIA_PATH}?delete=missing`, prod);
    }
    if (name === 'MediaInUseError') {
      return redirect(`${ADMIN_MEDIA_PATH}?delete=in-use#${mediaId}`, prod);
    }
    return redirect(`${ADMIN_MEDIA_PATH}?delete=error`, prod);
  }
};

export const GET: APIRoute = async () => {
  // Mutation interdite par GET : retour à la médiathèque, sans effet.
  return new Response(null, { status: 303, headers: { Location: ADMIN_MEDIA_PATH } });
};
