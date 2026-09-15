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
 * Alt text (mission §16) — mutation POST progressive (formulaire sans
 * JavaScript), même socle que les autres mutations admin : guard de
 * session, CSRF, same-site. Saisi par l'admin, jamais généré ; vide
 * autorisé (image décorative).
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
  // et réutilisé pour le CSRF et la valeur (une seconde lecture lève
  // « Body has already been read »).
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

  if (!runtime.mediaAdmin) {
    return redirect(`${ADMIN_MEDIA_PATH}?alt=not-configured`, prod);
  }

  const mediaId = ctx.params.id ?? '';
  const altTextRaw = formData.get('alt_text');
  const altText = typeof altTextRaw === 'string' ? altTextRaw : '';

  try {
    await runtime.mediaAdmin.updateAlt({
      mediaId,
      altText,
      actorAdminId: access.admin.id,
    });
    return redirect(`${ADMIN_MEDIA_PATH}?alt=1#${mediaId}`, prod);
  } catch (error) {
    if ((error as { name?: string }).name === 'MediaNotFoundError') {
      return redirect(`${ADMIN_MEDIA_PATH}?alt=missing`, prod);
    }
    return redirect(`${ADMIN_MEDIA_PATH}?alt=error`, prod);
  }
};

export const GET: APIRoute = async () => {
  // Mutation interdite par GET : retour à la médiathèque, sans effet.
  return new Response(null, { status: 303, headers: { Location: ADMIN_MEDIA_PATH } });
};
