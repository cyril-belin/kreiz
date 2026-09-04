import type { APIRoute } from 'astro';
import config from 'virtual:kreiz/config';

export const prerender = false;

/**
 * Route de spike (slice 0) : prouve qu'une route injectée par le Core via
 * son API publique fonctionne en dev et au build avec l'adapter Vercel, et
 * reçoit la configuration fournie par l'application consommatrice.
 *
 * À supprimer quand les vraies routes Kreiz (admin, endpoints) la remplacent.
 */
export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify(
      {
        ok: true,
        source: '@kreiz/core',
        spikeMessage: config.spike?.message ?? null,
      },
      null,
      2,
    ),
    {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
};
