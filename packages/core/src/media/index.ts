/**
 * API publique du domaine média — sous-chemin `@kreiz/core/media`
 * (slice 5). Le Project consomme ici les types et helpers de rendu des
 * médias publics ; les ports (`ObjectStorage`, `ImageTransformer`,
 * `BackgroundJobs`) et les adapters restent internes (le canal de
 * configuration est l'environnement runtime, comme la base). La couche
 * data reste la seule porte Drizzle/Neon.
 */

// Vue publique d'un média (cover des templates) + résolution
export type { PublicMediaView, PublicMediaVariant } from '../domain/media/view-model.js';
export {
  resolvePublicMediaView,
  normalizeMediaPublicBaseUrl,
} from '../domain/media/view-model.js';

// Helpers `<picture>` responsive — le Project reste maître du layout
export { mediaSources, mediaFallbackSrc } from '../domain/media/picture.js';
export type { MediaPictureSource } from '../domain/media/picture.js';

// Politique V1 (bornes de validation — utiles aux projets pour leur UI)
export {
  MEDIA_ACCEPTED_MIME_TYPES,
  MEDIA_MAX_UPLOAD_BYTES,
  MEDIA_MAX_PIXELS,
  MEDIA_VARIANT_WIDTHS,
  MEDIA_ALT_MAX_LENGTH,
} from '../domain/media/policy.js';

// Lecteur de build (couvertures publiques résolues avec les contenus)
export { createContentReader } from '../content/reader.js';
export type { ContentReader } from '../content/reader.js';

// Erreurs de domaine média
export {
  KreizMediaError,
  MediaNotReadyError,
  MediaNotFoundError,
  MediaInUseError,
  MediaStateError,
} from '../domain/media/errors.js';
