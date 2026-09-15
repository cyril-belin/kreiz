export const prerender = false;

import type { APIRoute } from 'astro';
import { authenticateMediaApi, mediaJsonResponse } from '../../http/media-api.js';

/**
 * Statut d'un média — GET JSON authentifié (mission §35) : le client
 * poll après la confirmation, interval raisonnable, arrêt sur
 * `ready`/`failed`. Lecture seule : pas de CSRF, la session suffit.
 */
export const GET: APIRoute = async (ctx) => {
  const prod = import.meta.env.PROD === true;
  const access = await authenticateMediaApi(ctx);
  if (access.kind === 'denied') return access.response;

  const { runtime } = access;
  if (!runtime.mediaAdmin) {
    return mediaJsonResponse({ error: 'storage-not-configured' }, 503, prod);
  }
  const status = await runtime.mediaAdmin.statusOf(ctx.params.id ?? '');
  if (!status) {
    return mediaJsonResponse({ error: 'not-found' }, 404, prod);
  }
  return mediaJsonResponse(status, 200, prod);
};
