export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticateMediaApi, mediaJsonResponse } from '../../http/media-api.js';
import { createMediaJobsForRequest, platformWaitUntil } from '../../http/admin-runtime.js';

/**
 * Confirmation post-upload (mission §10) — POST JSON authentifié. Le
 * serveur vérifie l'objet **réel** (existence, taille, magic bytes) avant
 * `uploading → processing` puis planifie la transformation via
 * `waitUntil` (jamais dans le chemin de la requête, mission §18).
 *
 * Idempotent (mission §11) : un double confirm sur `processing`/`ready`
 * répond un succès explicite ; sur `failed`, un état explicite (le client
 * doit passer par le retry admin).
 */
export const POST: APIRoute = async (ctx) => {
  const prod = import.meta.env.PROD === true;
  const access = await authenticateMediaApi(ctx);
  if (access.kind === 'denied') return access.response;

  const { runtime } = access;
  const mediaId = ctx.params.id ?? '';
  const jobs = createMediaJobsForRequest(runtime, platformWaitUntil(ctx.locals));
  if (!runtime.upload || !jobs) {
    return mediaJsonResponse({ error: 'storage-not-configured' }, 503, prod);
  }

  try {
    const outcome = await runtime.upload.confirmUpload(
      { mediaId, actorAdminId: access.access.admin.id },
      { jobs },
    );
    switch (outcome.kind) {
      case 'confirmed':
      case 'already-processing':
      case 'already-ready':
        return mediaJsonResponse(
          { mediaId: outcome.media.id, status: outcome.media.status },
          202,
          prod,
        );
      case 'object-missing':
        return mediaJsonResponse(
          {
            mediaId: outcome.media.id,
            status: outcome.media.status,
            error: 'object-missing',
            message: "L'objet n'est pas encore présent dans le stockage — réessayez.",
          },
          409,
          prod,
        );
      case 'failed':
      case 'rejected':
        return mediaJsonResponse(
          {
            mediaId: outcome.media.id,
            status: outcome.media.status,
            error: 'rejected',
            reason: outcome.kind === 'rejected' ? outcome.reason : (outcome.media.failureReason ?? 'failed'),
          },
          422,
          prod,
        );
    }
  } catch (error) {
    if ((error as { name?: string }).name === 'MediaNotFoundError') {
      return mediaJsonResponse({ error: 'not-found' }, 404, prod);
    }
    throw error;
  }
};

export const GET: APIRoute = async () => {
  // Confirmation interdite par GET : retour à la médiathèque, sans effet.
  return new Response(null, { status: 303, headers: { Location: '/admin/media' } });
};
