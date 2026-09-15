import type { APIContext } from 'astro';
import { getKreizContentRuntime, type KreizContentRuntime } from './admin-runtime.js';
import { adminApiDenyStatus, resolveAdminAccess, sessionTokenFromCookies } from './guards.js';
import { adminSecurityHeaders } from './security-headers.js';
import { isTrustedSameSiteMutation } from './mutations.js';
import { verifySessionCsrfToken } from './csrf.js';
import type { AdminAccess } from './guards.js';

/**
 * Socle commun des **endpoints JSON médias** (upload-request, confirm,
 * status) — même discipline que les pages (invariants slice 2, mission
 * §36/§37) : en-têtes admin, guard de session, same-site/Fetch Metadata,
 * CSRF lié à la session. Seule différence d'usage : le token CSRF voyage en
 * **en-tête** (`x-kreiz-csrf-token`) plutôt qu'en champ de formulaire —
 * le canal est vérifié par la même fonction cryptographique.
 *
 * Aucun de ces endpoints n'est public : la présignature d'upload est une
 * mutation/autorisation sensible (mission §37).
 */
export const CSRF_HEADER_FIELD = 'x-kreiz-csrf-token';

export type MediaApiAccess =
  | {
      kind: 'authenticated';
      runtime: KreizContentRuntime;
      access: Extract<AdminAccess, { kind: 'authenticated' }>;
      sessionToken: string;
    }
  | { kind: 'denied'; response: Response };

function jsonResponse(body: unknown, status: number, prod: boolean): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...adminSecurityHeaders({ prod }) },
  });
}

/** Résout l'accès à un endpoint JSON média — `denied` porte la réponse prête.
 * (Chaque réponse JSON porte elle-même les en-têtes admin — `APIContext`
 * n'expose pas `response`, réservé au global `Astro` des pages.) */
export async function authenticateMediaApi(ctx: APIContext): Promise<MediaApiAccess> {
  const prod = import.meta.env.PROD === true;
  const runtime = getKreizContentRuntime();
  const sessionToken = sessionTokenFromCookies(ctx.cookies);
  const access = await resolveAdminAccess(runtime.auth, sessionToken);
  if (access.kind === 'unauthenticated') {
    return {
      kind: 'denied',
      response: jsonResponse(
        { error: 'unauthenticated' },
        adminApiDenyStatus(access.reason),
        prod,
      ),
    };
  }

  // Mutations (POST) : same-site/Fetch Metadata + CSRF en en-tête.
  if (ctx.request.method === 'POST') {
    if (!isTrustedSameSiteMutation(ctx.request)) {
      return { kind: 'denied', response: jsonResponse({ error: 'refused' }, 403, prod) };
    }
    const submitted = ctx.request.headers.get(CSRF_HEADER_FIELD);
    if (!verifySessionCsrfToken(sessionToken ?? '', submitted)) {
      return { kind: 'denied', response: jsonResponse({ error: 'refused' }, 403, prod) };
    }
  }

  return {
    kind: 'authenticated',
    runtime,
    access,
    sessionToken: sessionToken ?? '',
  };
}

export { jsonResponse as mediaJsonResponse };
