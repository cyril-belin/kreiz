import { createHash, timingSafeEqual } from 'node:crypto';
import type { ContactService } from '../services/contact.js';
import type { MediaRecoveryService } from '../services/media-recovery.js';
import type { AnalyticsService } from '../services/analytics.js';

/**
 * **Endpoint de maintenance** (`POST /api/maintenance`, passe de fermeture
 * pré-production) — déclencheur minimal pour un scheduler **externe**
 * (Vercel Cron, systemd timer…). Aucun scheduler interne, aucun framework
 * de jobs : le cron appelle uniquement les services de recovery existants,
 * dans l'ordre, sans jamais dupliquer de logique métier.
 *
 * Authentification machine-to-machine (jamais une session admin navigateur) :
 * - `KREIZ_MAINTENANCE_TOKEN` (≥ 32 caractères) — **sans valeur configurée,
 *   toute requête reçoit un 503 et rien ne s'exécute** (refus par défaut,
 *   y compris en production) ;
 * - `Authorization: Bearer <token>` obligatoire ; la comparaison est
 *   **temps constant** (les deux valeurs sont hachées SHA-256 avant
 *   `timingSafeEqual` — aucune fuite de longueur ni de préfixe) ;
 * - erreur → 401 sans aucun indice (message identique, corps minimal).
 *
 * Réponse : compteurs techniques uniquement (`{ purged, recovered, sent… }`)
 * — **aucune PII**, jamais le contenu d'une demande, jamais un secret.
 * Idempotence garantie par les services sous-jacents (claims conditionnels,
 * purges bornées, transitions gardées) : deux appels rapprochés sont sûrs,
 * le second trouve rarement du travail.
 */

export type MaintenanceServices = {
  contact: Pick<ContactService, 'runNotificationRecovery' | 'runContactRetention'> | null;
  recovery: Pick<MediaRecoveryService, 'processStuckMedia'> | null;
  analytics: Pick<AnalyticsService, 'runRetention'> | null;
};

export type MaintenanceRequestInput = {
  method: string;
  /** En-tête `authorization` brut, ou `null`. */
  authorization: string | null;
  /** Token configuré (`KREIZ_MAINTENANCE_TOKEN`), ou `null` si absent. */
  configuredToken: string | null;
  /** Rétention contact configurée (jours), ou `null` — sans elle, pas de purge. */
  contactRetentionDays: number | null;
  services: MaintenanceServices;
};

export type MaintenanceOutcome = { status: number; body: Record<string, unknown> };

/**
 * Résume un bearer token en SHA-256 : la comparaison temps constant opère
 * sur des résumés de longueur fixe — aucune information de longueur ou de
 * contenu partiel ne fuit par le temps de comparaison.
 */
function bearerDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function bearerFromHeader(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1]?.trim() ?? null) : null;
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(bearerDigest(left), bearerDigest(right));
}

export async function handleMaintenanceRequest(input: MaintenanceRequestInput): Promise<MaintenanceOutcome> {
  if (input.method !== 'POST') {
    return { status: 405, body: { error: 'method-not-allowed' } };
  }
  // Refus par défaut : sans token configuré, rien ne s'exécute — quel que
  // soit l'en-tête fourni (y compris un en-tête vide ou malformé).
  if (!input.configuredToken) {
    return { status: 503, body: { error: 'maintenance-not-configured' } };
  }
  const provided = bearerFromHeader(input.authorization);
  if (!provided || !safeEqual(provided, input.configuredToken)) {
    return { status: 401, body: { error: 'refused' } };
  }

  const now = new Date();
  // Chaque recovery est isolée : l'échec d'une ne prive pas les autres ni
  // la réponse (le statut reste 200 — le cron voit les compteurs, un
  // `{error:'failed'}` désigne le domaine en échec).
  const body: Record<string, unknown> = {};

  try {
    body.contactNotification = await input.services.contact?.runNotificationRecovery({ now }) ?? null;
  } catch {
    body.contactNotification = { error: 'failed' };
  }

  try {
    const retention =
      await input.services.contact?.runContactRetention({
        retentionDays: input.contactRetentionDays,
        now,
      }) ?? null;
    // `null` = rétention non configurée (décision opérateur) — explicite
    // dans la réponse, jamais silencieux.
    body.contactRetention = retention ?? { disabled: true };
  } catch {
    body.contactRetention = { error: 'failed' };
  }

  try {
    body.mediaStuck =
      (await input.services.recovery?.processStuckMedia({ now })) ?? { unavailable: true };
  } catch {
    body.mediaStuck = { error: 'failed' };
  }

  try {
    const retention = await input.services.analytics?.runRetention({ now }) ?? null;
    body.analyticsRetention = retention ?? { disabled: true };
  } catch {
    body.analyticsRetention = { error: 'failed' };
  }

  return { status: 200, body };
}
