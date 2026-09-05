export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_HOME_PATH, ADMIN_LOGIN_PATH } from '../../http/admin-routes.js';
import {
  ADMIN_COOKIE_PATH,
  ADMIN_SESSION_COOKIE_NAME,
} from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizAdminRuntime } from '../../http/server-env.js';

/**
 * Déconnexion — une **mutation** : POST uniquement, protégé par le token
 * CSRF lié à la session (et par les contrôles same-origin/Fetch Metadata).
 * Un GET sur /admin/logout n'a aucun effet de bord.
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
  const runtime = getKreizAdminRuntime();
  const sessionToken = sessionTokenFromCookies(ctx.cookies);

  if (!sessionToken) {
    // Pas de session : rien à révoquer, retour au login.
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect(ADMIN_LOGIN_PATH, prod);
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

  // Vérification CSRF AVANT toute action — un token absent ou invalide
  // ne touche jamais la base.
  if (!verifySessionCsrfToken(sessionToken, typeof csrfSubmitted === 'string' ? csrfSubmitted : null)) {
    return forbidden(prod);
  }

  await runtime.auth.logout(sessionToken);
  ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
  return redirect(ADMIN_LOGIN_PATH, prod);
};

export const GET: APIRoute = async () => {
  // Logout interdit par GET : simple retour vers le shell (ou le login).
  return new Response(null, {
    status: 303,
    headers: { Location: ADMIN_HOME_PATH },
  });
};
