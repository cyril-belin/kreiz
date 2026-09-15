export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticateMediaApi, mediaJsonResponse } from '../../http/media-api.js';

/**
 * Demande d'upload présigné (mission §3, §37) — POST JSON authentifié :
 * session admin, CSRF en en-tête, same-origin. **Jamais** un endpoint
 * public de présignature.
 *
 * Entrée : `{ mime, sizeBytes }` — métadonnées **annoncées** (premier
 * niveau de validation ; l'objet réel est vérifié au confirm, mission §4).
 * Sortie : `{ mediaId, status, upload: { url, method, headers } }` — le
 * navigateur envoie ensuite le fichier **directement** au stockage
 * (l'URL est courte durée, limitée à la clé, content-type figé).
 */
export const POST: APIRoute = async (ctx) => {
  const prod = import.meta.env.PROD === true;
  const access = await authenticateMediaApi(ctx);
  if (access.kind === 'denied') return access.response;

  const { runtime } = access;
  if (!runtime.upload || !runtime.storage) {
    return mediaJsonResponse({ error: 'storage-not-configured' }, 503, prod);
  }

  let payload: unknown;
  try {
    payload = await ctx.request.json();
  } catch {
    return mediaJsonResponse({ error: 'invalid-request' }, 400, prod);
  }

  const outcome = await runtime.upload.createUploadRequest({
    actorAdminId: access.access.admin.id,
    request: payload,
  });

  if (outcome.kind === 'invalid') {
    return mediaJsonResponse(
      {
        error: 'invalid-metadata',
        message: 'Type MIME non supporté ou taille invalide — 20 Mo maximum.',
      },
      422,
      prod,
    );
  }

  return mediaJsonResponse(
    {
      mediaId: outcome.media.id,
      status: outcome.media.status,
      upload: {
        url: outcome.upload.url,
        method: outcome.upload.method,
        headers: outcome.upload.headers,
        expiresAt: outcome.upload.expiresAt.toISOString(),
      },
    },
    201,
    prod,
  );
};

export const GET: APIRoute = async () => {
  // Présignature interdite par GET (mutation sensible).
  return new Response(null, { status: 303, headers: { Location: '/admin/media' } });
};
