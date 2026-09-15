export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_MEDIA_PATH } from '../../http/admin-routes.js';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import { createMediaJobsForRequest, platformWaitUntil } from '../../http/admin-runtime.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Retry d'un média `failed` (mission §22) — mutation POST progressive :
 * `failed → processing` + enqueue. Pas de retry automatique infini :
 * chaque retry est une action d'admin explicite, audité
 * (`media.retried`, acteur réel).
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

  const jobs = createMediaJobsForRequest(runtime, platformWaitUntil(ctx.locals));
  if (!runtime.mediaAdmin || !jobs) {
    return redirect(`${ADMIN_MEDIA_PATH}?retry=not-configured`, prod);
  }

  const mediaId = ctx.params.id ?? '';
  try {
    await runtime.mediaAdmin.retryMedia(
      { mediaId, actorAdminId: access.admin.id },
      { jobs },
    );
    return redirect(`${ADMIN_MEDIA_PATH}?retry=1#${mediaId}`, prod);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'MediaNotFoundError') {
      return redirect(`${ADMIN_MEDIA_PATH}?retry=missing`, prod);
    }
    if (name === 'MediaStateError') {
      return redirect(`${ADMIN_MEDIA_PATH}?retry=invalid#${mediaId}`, prod);
    }
    return redirect(`${ADMIN_MEDIA_PATH}?retry=error`, prod);
  }
};

export const GET: APIRoute = async () => {
  // Mutation interdite par GET : retour à la médiathèque, sans effet.
  return new Response(null, { status: 303, headers: { Location: ADMIN_MEDIA_PATH } });
};
