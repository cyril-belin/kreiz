import { z } from 'zod';
import {
  ANALYTICS_CTA_ID_MAX_LENGTH,
  ANALYTICS_LOCALE_MAX_LENGTH,
  ANALYTICS_PATH_MAX_LENGTH,
  ANALYTICS_REFERRER_INPUT_MAX_LENGTH,
  ANALYTICS_SESSION_MAX_LENGTH,
  ANALYTICS_UTM_FIELDS,
  ANALYTICS_UTM_MAX_LENGTH,
  type AnalyticsClientEventName,
  type AnalyticsUtm,
  type AnalyticsUtmField,
  classifyReferrer,
  emptyUtm,
  normalizeAnalyticsLocale,
  normalizeAnalyticsPath,
  normalizeAnalyticsSession,
  normalizeCtaId,
  normalizeReferrerDomain,
  normalizeUtmValue,
} from './policy.js';

/**
 * Parseur du payload beacon — **whitelist stricte, structure fermée**.
 *
 * Le corps JSON brut est décrit par un schéma Zod `strict` (clés inconnues
 * rejetées) puis **normalisé champ par champ** par la politique : le client
 * ne peut ni ajouter une propriété, ni élargir une borne, ni injecter de
 * structure arbitraire — le JSONB `metadata` stocké est construit côté
 * serveur uniquement. Toute entrée non conforme est une **ignorance
 * silencieuse de champ** (valeur → `null`) ou un rejet global du payload —
 * jamais une erreur verbeuse renvoyée au client.
 */

/** Observation client normalisée, prête à être persistée par le service. */
export interface NormalizedClientEvent {
  name: AnalyticsClientEventName;
  path: string;
  /** Domaine de referrer normalisé — `null` = accès direct. */
  referrerDomain: string | null;
  /** `internal` / `external` / `null` (direct). */
  referrerKind: 'internal' | 'external' | null;
  /** Session UUID éphémère validée — `null` si absente ou non conforme. */
  sessionId: string | null;
  utm: AnalyticsUtm;
  locale: string | null;
  /** Identifiant de CTA (`cta_click` uniquement). */
  ctaId: string | null;
}

export type ClientEventParseResult =
  | { kind: 'valid'; event: NormalizedClientEvent }
  | { kind: 'invalid'; reason: 'schema' };

/** Schéma brut du beacon — bornes de lecture AVANT normalisation (troncature défensive). */
const beaconPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pv'),
    path: z.string().max(ANALYTICS_PATH_MAX_LENGTH),
    ref: z.string().max(ANALYTICS_REFERRER_INPUT_MAX_LENGTH).optional(),
    session: z.string().max(ANALYTICS_SESSION_MAX_LENGTH).optional(),
    utm: z
      .strictObject(
        Object.fromEntries(
          ANALYTICS_UTM_FIELDS.map((field) => [
            field,
            z.string().max(ANALYTICS_UTM_MAX_LENGTH).optional(),
          ]),
        ),
      )
      .optional(),
    locale: z.string().max(ANALYTICS_LOCALE_MAX_LENGTH).optional(),
  }),
  z.strictObject({
    type: z.literal('cta'),
    path: z.string().max(ANALYTICS_PATH_MAX_LENGTH),
    session: z.string().max(ANALYTICS_SESSION_MAX_LENGTH).optional(),
    id: z.string().max(ANALYTICS_CTA_ID_MAX_LENGTH).optional(),
  }),
]);

/**
 * Parse et normalise un payload beacon déjà extrait du corps (JSON parsé
 * par la route, taille déjà bornée). `requestHost` et `internalDomains`
 * servent à la classification du referrer.
 */
export function parseClientEvent(
  payload: unknown,
  context: { requestHost: string | null; internalDomains?: readonly string[] },
): ClientEventParseResult {
  const parsed = beaconPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: 'invalid', reason: 'schema' };
  }
  const raw = parsed.data;
  const path = normalizeAnalyticsPath(raw.path);
  // Un chemin non normalisable = événement sans valeur analytique : rejet
  // global (pas de ligne au chemin vide) — le beacon n'envoie que des
  // pathname valides, c'est un signal de client hostile.
  if (!path) return { kind: 'invalid', reason: 'schema' };
  const sessionId = normalizeAnalyticsSession(raw.session ?? null);

  if (raw.type === 'pv') {
    const referrerDomain = normalizeReferrerDomain(raw.ref ?? null);
    const utm: AnalyticsUtm = { ...emptyUtm() };
    if (raw.utm) {
      for (const field of ANALYTICS_UTM_FIELDS) {
        (utm as Record<AnalyticsUtmField, string | null>)[field] = normalizeUtmValue(raw.utm[field]);
      }
    }
    return {
      kind: 'valid',
      event: {
        name: 'page_view',
        path,
        referrerDomain,
        referrerKind: classifyReferrer(referrerDomain, context),
        sessionId,
        utm,
        locale: normalizeAnalyticsLocale(raw.locale ?? null),
        ctaId: null,
      },
    };
  }

  // CTA : le beacon n'envoie pas de referrer — attribution = page courante.
  return {
    kind: 'valid',
    event: {
      name: 'cta_click',
      path,
      referrerDomain: null,
      referrerKind: null,
      sessionId,
      utm: emptyUtm(),
      locale: null,
      ctaId: normalizeCtaId(raw.id ?? null),
    },
  };
}
