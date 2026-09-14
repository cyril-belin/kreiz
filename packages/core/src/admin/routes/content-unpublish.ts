export const prerender = false;

import type { APIRoute } from 'astro';
import { ADMIN_COOKIE_PATH, ADMIN_SESSION_COOKIE_NAME } from '../../http/cookies.js';
import { CSRF_FORM_FIELD, verifySessionCsrfToken } from '../../http/csrf.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import {
  ADMIN_LOGIN_PATH,
  adminContentEditPath,
  adminContentTypePath,
} from '../../http/admin-routes.js';
import { sessionTokenFromCookies } from '../../http/guards.js';
import { isTrustedSameSiteMutation } from '../../http/mutations.js';

/**
 * Dépublication d'un contenu — **mutation** POST uniquement, même socle de
 * garde que le slice 2 (same-site + CSRF lié à la session). Retour au draft,
 * contenu et historique public conservés, audit `content.unpublished`,
 * rebuild demandé (mission §7). Un GET n'a aucun effet de bord.
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
    return new Response(null, { status: 404, headers: adminSecurityHeaders({ prod }) });
  }

  try {
    // Isolation des types : le contenu doit appartenir au type de la route.
    const loaded = await runtime.content.getContentForEdit(entryId);
    if (loaded.entry.contentType !== declaration.key) {
      return new Response(null, { status: 404, headers: adminSecurityHeaders({ prod }) });
    }

    const outcome = await runtime.publication.unpublishContent({
      entryId,
      actorAdminId: access.admin.id,
    });

    if (outcome.kind === 'not-published') {
      // Déjà en draft : retour édition sans bandeau (idempotent).
      return redirect(adminContentEditPath(declaration.key, entryId), prod);
    }

    const url = new URL(adminContentEditPath(declaration.key, entryId), 'http://k');
    url.searchParams.set('unpublished', '1');
    url.searchParams.set(
      'rebuild',
      outcome.rebuild.ok
        ? 'ok'
        : outcome.rebuild.failure.kind === 'not-configured'
          ? 'unconfigured'
          : 'failed',
    );
    return redirect(`${url.pathname}${url.search}`, prod);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'ContentNotFoundError' || name === 'ContentDeletedError') {
      return redirect(adminContentTypePath(declaration.key), prod);
    }
    return new Response('Erreur interne.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...adminSecurityHeaders({ prod }) },
    });
  }
};

export const GET: APIRoute = async (ctx) => {
  // Dépublication interdite par GET : retour à l'édition.
  const typeKey = ctx.params.type ?? '';
  const entryId = ctx.params.id ?? '';
  const runtime = getKreizContentRuntime();
  const declaration = runtime.content.registry.findByKey(typeKey);
  return redirect(
    declaration ? adminContentEditPath(declaration.key, entryId) : '/admin/content',
    false,
  );
};
