import { z } from 'zod';

/**
 * Politique médias V1 (mission §4, §5, §41 ; cadrage §11, §23.6) — règles
 * pures, aucune I/O.
 *
 * - **Taille** : 20 Mo maximum **par upload**, vérifiée deux fois : avant la
 *   présignature (métadonnées annoncées par le client — simple filtrage
 *   anticipé) et après l'upload (objet réel `head` + lecture — seule source
 *   de vérité, le navigateur n'est jamais cru).
 * - **Types MIME** : allowlist fermée. V1 accepte jpeg/png/webp en entrée —
 *   plus AVIF si le runtime de transformation le décode proprement (le
 *   transformer de référence, Sharp, le décode) ; pas de SVG (vecteur
 *   d'attaque actif — XSS via script embed, injection XML — sans besoin
 *   démontré en V1). L'extension de fichier n'est **jamais** une preuve :
 *   le type réel est vérifié par lecture des magic bytes du contenu.
 * - **Pixels** : borne anti « decompression bomb » — une image valide mais
 *   gigantesque (ex. 40 000 × 40 000 jpeg) reste refusée avant
 *   décodage/compression. 30 MP ≈ 7000 × 4300 : largement au-dessus des
 *   besoins éditoriaux, très en dessous des limites par défaut de Sharp
 *   (~268 MP) pour contenir le coût CPU/mémoire d'une lambda.
 * - **Alt text** : saisi par l'admin (jamais généré) ; vide autorisé
 *   (image décorative), borné anti-abus.
 */

/** Taille maximale d'un upload (octets) : 20 Mo. */
export const MEDIA_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Types MIME acceptés en entrée (allowlist fermée — pas de SVG en V1). */
export const MEDIA_ACCEPTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
] as const;

export type KreizMediaAcceptedMime = (typeof MEDIA_ACCEPTED_MIME_TYPES)[number];

/** Nombre maximal de pixels (largeur × hauteur) de l'original. */
export const MEDIA_MAX_PIXELS = 30_000_000;

/** Largeurs maximales des variantes générées (conservation du ratio, jamais d'upscale). */
export const MEDIA_VARIANT_WIDTHS = [400, 800, 1400, 2000] as const;

/** Formats de sortie des variantes. */
export const MEDIA_VARIANT_FORMATS = ['webp', 'avif'] as const;

export type KreizMediaVariantFormat = (typeof MEDIA_VARIANT_FORMATS)[number];

/** Longueur maximale de l'alt text (borne anti-abus, pas une règle éditoriale). */
export const MEDIA_ALT_MAX_LENGTH = 1_000;

/** Durée de vie d'une URL d'upload présignée (mission §9 : 5–15 min, 10 retenu). */
export const MEDIA_PRESIGN_EXPIRY_SECONDS = 600;

/** Schéma de la demande d'upload — métadonnées **annoncées** par le client. */
export const mediaUploadRequestSchema = z.strictObject({
  mime: z.enum(MEDIA_ACCEPTED_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MEDIA_MAX_UPLOAD_BYTES),
});

export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;

/** Schéma de la saisie d'alt text (mutation admin dédiée). */
export const mediaAltInputSchema = z.string().max(MEDIA_ALT_MAX_LENGTH);

/** Valide les métadonnées annoncées — premier des deux niveaux de validation. */
export function parseMediaUploadRequest(input: unknown): MediaUploadRequest | null {
  const parsed = mediaUploadRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Libellé lisible d'un type MIME accepté — messages d'erreur admin.
 */
export function acceptedMimeLabel(): string {
  return MEDIA_ACCEPTED_MIME_TYPES.join(', ');
}
