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
 * Publication d'un contenu — **mutation** POST uniquement, protégée par le
 * socle du slice 2 (same-site + CSRF lié à la session, vérifiés avant toute
 * action — jamais un deuxième système). Valide l'état courant, fige le
 * dernier état public, crée la redirection si le slug public change, audite
 * `content.published`, demande la reconstruction (mission §3-§4). Un GET
 * n'a aucun effet de bord.
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

/** Retour édition avec le résultat de la publication encodé dans l'URL (bannières). */
function backToEdit(
  typeKey: string,
  entryId: string,
  params: { rebuild?: 'ok' | 'failed' | 'unconfigured'; error?: 'validation' | 'conflict' },
  prod: boolean,
): Response {
  const url = new URL(adminContentEditPath(typeKey, entryId), 'http://k');
  if (params.rebuild) url.searchParams.set('rebuild', params.rebuild);
  if (params.error) url.searchParams.set('publish_error', params.error);
  if (params.rebuild) url.searchParams.set('published', '1');
  return redirect(`${url.pathname}${url.search}`, prod);
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

    const outcome = await runtime.publication.publishContent({
      entryId,
      actorAdminId: access.admin.id,
    });

    if (outcome.kind === 'invalid') {
      // Données courantes invalides (corruption directe en base) : la
      // publication a échoué avant toute écriture — retour édition.
      return backToEdit(declaration.key, entryId, { error: 'validation' }, prod);
    }

    return backToEdit(
      declaration.key,
      entryId,
      {
        rebuild: outcome.rebuild.ok
          ? 'ok'
          : outcome.rebuild.failure.kind === 'not-configured'
            ? 'unconfigured'
            : 'failed',
      },
      prod,
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'PublishedPathOccupiedError') {
      // Conflit : l'ancien chemin public est occupé par un autre contenu —
      // message explicite, aucune écriture effectuée (mission §19).
      return backToEdit(declaration.key, entryId, { error: 'conflict' }, prod);
    }
    if (name === 'ContentNotFoundError' || name === 'ContentDeletedError') {
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
  // Publication interdite par GET : retour à l'édition.
  const typeKey = ctx.params.type ?? '';
  const entryId = ctx.params.id ?? '';
  const runtime = getKreizContentRuntime();
  const declaration = runtime.content.registry.findByKey(typeKey);
  return redirect(
    declaration ? adminContentEditPath(declaration.key, entryId) : '/admin/content',
    false,
  );
};
