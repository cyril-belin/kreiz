export const prerender = false;

import type { APIRoute } from 'astro';
import { getKreizContentRuntime } from '../http/admin-runtime.js';
import { isTrustedSameSiteMutation } from '../http/mutations.js';
import { clientIpFromHeaders } from '../http/admin-login.js';
import { normalizeAnalyticsPath } from '../domain/analytics/policy.js';
import {
  ANALYTICS_BODY_MAX_BYTES,
  hasExplicitPrivacySignal,
  isPrefetchRequest,
} from '../domain/analytics/policy.js';

/**
 * Endpoint public de collecte analytics — `POST /api/analytics/event`
 * (slice 8 ; hors `/admin`, **jamais** de session admin ici).
 *
 * Contrat : POST JSON strictement borné (2 KiB), schéma fermé, réponse
 * **toujours muette** — 204 (stocké, doublon ou ignoré : bots, préfetch,
 * DNT/GPC, chemins exclus), 400 (payload illisible), 403 (origine croisée),
 * 429 (rate limit). Aucun corps d'erreur, aucun écho du payload : l'endpoint
 * ne doit jamais être un oracle ni un journal de données visiteur.
 *
 * Toutes les décisions (activation, vie privée, bots, chemins exclus,
 * stockage) appartiennent au service — la route ne fait que traduire
 * l'HTTP : bornes de transport, détection des signaux serveur, statuts.
 */
export const POST: APIRoute = async (ctx) => {
  const runtime = getKreizContentRuntime();

  // Origine croisée refusée avant toute lecture (même garde que les POST
  // publics de formulaires). Un client sans ces en-têtes (curl) n'est pas
  // un vecteur CSRF : il retombe sous le rate limiting.
  if (!isTrustedSameSiteMutation(ctx.request)) {
    return emptyResponse(403);
  }

  const contentType = (ctx.request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return emptyResponse(400);
  }

  // Borne de transport : Content-Length d'abord (rejet sans lecture), puis
  // lecture effective **plafonnée en streaming** (ne jamais faire confiance
  // au seul en-tête, ne jamais bufferiser un corps géant).
  const contentLength = Number(ctx.request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > ANALYTICS_BODY_MAX_BYTES) {
    return emptyResponse(400);
  }
  const raw = await readBodyCapped(ctx.request, ANALYTICS_BODY_MAX_BYTES);
  if (raw === null) {
    return emptyResponse(400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emptyResponse(400);
  }

  let requestHost: string | null = null;
  try {
    requestHost = new URL(ctx.request.url).host;
  } catch {
    requestHost = null;
  }

  const outcome = await runtime.analytics.collectBeacon({
    payload,
    userAgent: ctx.request.headers.get('user-agent'),
    clientIp: clientIpFromHeaders(ctx.request.headers),
    privacySignal: hasExplicitPrivacySignal(ctx.request.headers),
    prefetch: isPrefetchRequest(ctx.request.headers),
    requestHost,
  });

  switch (outcome.kind) {
    case 'stored':
    case 'duplicate':
    case 'ignored':
      return emptyResponse(204);
    case 'rejected':
      if (outcome.reason === 'rate-limited') {
        const response = emptyResponse(429);
        response.headers.set('retry-after', String(outcome.retryAfterSeconds));
        return response;
      }
      return emptyResponse(400);
  }
};

export const GET: APIRoute = async () => emptyResponse(405);

/** Réponse sans corps — l'endpoint n'écho jamais de payload. */
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * Lecture du corps **plafonnée en streaming** : au-delà du cap, la lecture
 * est annulée immédiatement (`null`) — un corps géant privé de
 * `Content-Length` n'est jamais bufferisé en entier. Retourne `''` si la
 * requête n'a pas de corps.
 */
async function readBodyCapped(request: Request, capBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Chemin de la page référente (pour la conversion serveur) : uniquement si
 * le Referer est **same-origin** — sinon `null`. Query et fragment
 * systématiquement strippés : jamais de données sensibles d'URL en
 * analytics.
 */
export function analyticsPageFromReferer(request: Request): string | null {
  const referer = request.headers.get('referer');
  if (!referer) return null;
  let refererUrl: URL;
  try {
    refererUrl = new URL(referer);
  } catch {
    return null;
  }
  let requestHost: string | null = null;
  try {
    requestHost = new URL(request.url).host;
  } catch {
    requestHost = null;
  }
  if (!requestHost || refererUrl.host.toLowerCase() !== requestHost.toLowerCase()) return null;
  return normalizeAnalyticsPath(refererUrl.pathname);
}
