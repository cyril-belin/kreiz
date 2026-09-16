export const prerender = true;

import type { APIRoute } from 'astro';
import config from 'virtual:kreiz/config';
import { beaconModuleSource } from './beacon-source.js';

/**
 * Fichier beacon analytics — `/api/analytics/beacon.js`, route **prérendue**
 * : un fichier statique dans le build (servi par le CDN, jamais une
 * fonction). Le Project n'ajoute qu'un `<script defer>` : aucun runtime
 * dynamique sur le chemin critique des pages publiques, aucune dépendance
 * analytics externe, aucun domaine tiers.
 *
 * Désactivée (`analytics.enabled: false`), la route sert un **stub** vide :
 * le tag résiduel ne mesure rien et n'émet aucune requête. Le contenu est
 * figé au build — une configuration qui change passe par un rebuild, comme
 * tout le site statique.
 */
export const GET: APIRoute = async () => {
  return new Response(beaconModuleSource(config.analytics.enabled), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
};
