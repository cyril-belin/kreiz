export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import {
  adminContentTypePath,
  ADMIN_LOGIN_PATH,
} from '../../http/admin-routes.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Suppression d'un brouillon — **mutation** POST uniquement, protégée par le
 * token CSRF lié à la session et par les contrôles same-site (mission §24).
 * Soft delete : `deleted_at = now`, audit `content.deleted`, slug libéré par
 * l'index unique partiel — jamais de suppression physique. Un GET n'a aucun
 * effet de bord.
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

  // CSRF vérifié avant toute action — un token invalide ne touche jamais la base.
  if (!verifySessionCsrfToken(sessionToken, typeof csrfSubmitted === 'string' ? csrfSubmitted : null)) {
    return forbidden(prod);
  }

  const access = await runtime.auth.resolveSession(sessionToken);
  if (access.status !== 'authenticated') {
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return redirect(ADMIN_LOGIN_PATH, prod);
  }

  const typeKey = ctx.params.type ?? '';
  const entryId = ctx.params.id ?? '';
  const declaration = runtime.content.registry.findByKey(typeKey);
  if (!declaration) {
    // Type non déclaré : 404, sans détail (mission §27).
    return new Response(null, { status: 404, headers: adminSecurityHeaders({ prod }) });
  }

  try {
    // Isolation des types : le contenu doit appartenir au type de la route.
    const loaded = await runtime.content.getContentForEdit(entryId);
    if (loaded.entry.contentType !== declaration.key) {
      return new Response(null, { status: 404, headers: adminSecurityHeaders({ prod }) });
    }
    await runtime.content.deleteDraft({ entryId, actorAdminId: access.admin.id });
    return redirect(adminContentTypePath(declaration.key), prod);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'ContentNotFoundError' || name === 'ContentDeletedError') {
      // Déjà absent ou déjà supprimé : retour au listing, effet idempotent.
      return redirect(adminContentTypePath(declaration.key), prod);
    }
    // Données corrompues / erreur inattendue : 500 sobre.
    return new Response('Erreur interne.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...adminSecurityHeaders({ prod }) },
    });
  }
};

export const GET: APIRoute = async (ctx) => {
  // Suppression interdite par GET : retour au listing du type.
  const typeKey = ctx.params.type ?? '';
  const runtime = getKreizContentRuntime();
  const declaration = runtime.content.registry.findByKey(typeKey);
  return redirect(declaration ? adminContentTypePath(declaration.key) : '/admin/content', false);
};
