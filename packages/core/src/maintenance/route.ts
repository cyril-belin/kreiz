export const prerender = false;

import type { APIRoute } from 'astro';
import { getKreizContentRuntime } from '../http/admin-runtime.js';
import { handleMaintenanceRequest } from './endpoint.js';

/**
 * Route Astro du **endpoint de maintenance** — `POST /api/maintenance`
 * (passe de fermeture pré-production). Hors `/admin`, **jamais** de session
 * admin ici : l'authentification est un bearer token machine-to-machine
 * (`KREIZ_MAINTENANCE_TOKEN`, comparaison temps constant) — voir la doc du
 * module `endpoint.ts` pour le contrat complet (refus par défaut, compteurs
 * uniquement, idempotence). Destiné au cron externe (Vercel Cron), pas au
 * navigateur.
 */
export const POST: APIRoute = async (ctx) => {
  const runtime = getKreizContentRuntime();
  const outcome = await handleMaintenanceRequest({
    method: ctx.request.method,
    authorization: ctx.request.headers.get('authorization'),
    configuredToken: runtime.maintenanceToken,
    contactRetentionDays: runtime.contactRetentionDays,
    services: {
      contact: runtime.contact,
      recovery: runtime.recovery,
      analytics: runtime.analytics,
    },
  });
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
};

export const GET: APIRoute = async () => {
  return new Response(null, { status: 405 });
};
