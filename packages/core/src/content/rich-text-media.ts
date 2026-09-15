import type { MediaRepository } from '../data/repositories/media.js';
import type { FieldDescriptor } from '../domain/content/fields.js';
import { extractRichTextMediaIds, type KreizRichTextDocument } from '../domain/content/rich-text/document.js';
import { resolvePublicMediaView, type PublicMediaView } from '../domain/media/view-model.js';
import { ContentDataCorruptedError } from '../domain/content/errors.js';
import type { ContentFieldErrors } from '../services/content.js';
import { collectRichTextMediaIds } from '../domain/content/view-model.js';

/**
 * Résolution et validation des **médias référencés par le rich text**
 * (slice 6) — le point unique où « un document référence un média » reçoit
 * une décision, partagé par la preview, le build public et la publication :
 *
 * - **Build / preview** (`loadRichTextMediaMap`) : résolution batch `ready`
 *   uniquement ; une référence absente, non prête ou sans base publique est
 *   une corruption — échec explicite (même contrat que la couverture, slice
 *   5 §28/§29).
 * - **Publication** (`validateRichTextMediaForPublish`) : erreurs de champ
 *   françaises et affichables, **avant toute écriture** — un média
 *   inexistant, non `ready`, sans alt ou sans stockage public configuré
 *   empêche la publication (mission §12/§19 du slice 6).
 *
 * Politique d'alt (slice 6 §19 — décision) : l'alt public est **l'alt
 * canonique du média** (source unique, jamais d'override par document) et un
 * média inséré dans un corps publié doit avoir un alt non vide — une image
 * de contenu éditorial est présumée informative ; les images décoratives ne
 * se mettent pas dans un corps de texte. La légende reste optionnelle.
 */

/**
 * Résout un **lot d'ids** déjà collectés en vues publiques (`ready`
 * uniquement). Toute divergence est une corruption — échec explicite.
 * Niveau bas : l'appelant collecte ses ids (par page ou par build).
 */
export async function buildRichTextMediaMap(
  media: Pick<MediaRepository, 'listReadyByIds'>,
  mediaPublicBaseUrl: string | null,
  ids: ReadonlyArray<string>,
): Promise<Map<string, PublicMediaView>> {
  const resolved = new Map<string, PublicMediaView>();
  if (ids.length === 0) return resolved;
  if (!mediaPublicBaseUrl) {
    throw new ContentDataCorruptedError(
      '(build)',
      'média du rich text sans base publique configurée (KREIZ_STORAGE_PUBLIC_BASE_URL absente)',
    );
  }
  const rows = await media.listReadyByIds(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throw new ContentDataCorruptedError(
        id,
        'média référencé par le rich text absent ou non prêt (media)',
      );
    }
    resolved.set(id, resolvePublicMediaView(row, { publicBaseUrl: mediaPublicBaseUrl }));
  }
  return resolved;
}

/**
 * Résout les vues publiques des médias référencés par des données **validées**
 * (un appelant par page, résolution batch : une seule requête pour toutes
 * les références). Lève `ContentDataCorruptedError` sur toute divergence —
 * un document publié ne référence que des médias prêts.
 */
export async function loadRichTextMediaMap(
  media: Pick<MediaRepository, 'listReadyByIds'>,
  mediaPublicBaseUrl: string | null,
  fields: Record<string, FieldDescriptor> | undefined,
  data: Record<string, unknown>,
): Promise<Map<string, PublicMediaView>> {
  return buildRichTextMediaMap(
    media,
    mediaPublicBaseUrl,
    collectRichTextMediaIds(fields, data),
  );
}

/**
 * Carte **best-effort** pour l'admin (édition, preview, vues de service) :
 * seuls les médias prêts et servables sont résolus — les autres restent
 * absents de la carte et la figure n'est pas rendue (`richTextStrict:
 * false`). Un brouillon peut référencer un média en cours de traitement :
 * l'édition ne doit jamais échouer pour un rendu impossible (mission §12).
 */
export async function resolveReadyRichTextMediaMap(
  media: Pick<MediaRepository, 'listReadyByIds'>,
  mediaPublicBaseUrl: string | null,
  fields: Record<string, FieldDescriptor> | undefined,
  data: Record<string, unknown>,
): Promise<Map<string, PublicMediaView>> {
  const resolved = new Map<string, PublicMediaView>();
  const ids = collectRichTextMediaIds(fields, data);
  if (ids.length === 0 || !mediaPublicBaseUrl) return resolved;
  const rows = await media.listReadyByIds(ids);
  for (const row of rows) {
    resolved.set(row.id, resolvePublicMediaView(row, { publicBaseUrl: mediaPublicBaseUrl }));
  }
  return resolved;
}

/**
 * Validation de **publication** — complète et avant toute écriture : chaque
 * média référencé par un champ richText doit exister, être `ready` (les
 * documents publiés ne référencent jamais `uploading`/`processing`/`failed`),
 * porter un alt non vide et pouvoir être servi publiquement. Les erreurs
 * sont posées sur le champ concerné (`ContentFieldErrors`).
 */
export async function validateRichTextMediaForPublish(
  media: Pick<MediaRepository, 'findById'>,
  mediaPublicBaseUrl: string | null,
  fields: Record<string, FieldDescriptor>,
  data: Record<string, unknown>,
  errors: ContentFieldErrors,
): Promise<void> {
  for (const [name, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'richText') continue;
    const value = data[name];
    if (value === undefined || value === null || typeof value !== 'object') continue;
    const document = value as KreizRichTextDocument;
    for (const mediaId of extractRichTextMediaIds(document)) {
      if (errors[name]) break;
      const row = await media.findById(mediaId);
      if (!row || row.deletedAt) {
        errors[name] =
          'Le corps de texte référence un média qui n’existe plus — retirez l’image du contenu avant de publier.';
        continue;
      }
      if (row.status !== 'ready') {
        errors[name] =
          'Le corps de texte référence un média non prêt (en attente, en traitement ou en échec) — la publication exige des médias prêts.';
        continue;
      }
      if (row.altText.trim().length === 0) {
        errors[name] =
          'Le corps de texte référence une image sans texte alternatif — complétez son alt dans la médiathèque avant de publier.';
        continue;
      }
      if (!mediaPublicBaseUrl) {
        errors[name] =
          'Le stockage média public n’est pas configuré (KREIZ_STORAGE_PUBLIC_BASE_URL) — publication avec médias dans le corps impossible.';
      }
    }
  }
}
