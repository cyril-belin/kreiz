/**
 * API publique du moteur de contenu — sous-chemin `@kreiz/core/content`.
 *
 * C'est ici que le Project déclare ses types de contenu et consomme les
 * helpers de rendu. La couche data (`@kreiz/core/data`) reste la porte
 * Drizzle/Neon ; ce module n'expose aucune définition de table ni
 * repository brut — uniquement le contrat de déclaration, les règles pures
 * (slug, schéma, vue) et un lecteur de build pour les pages publiques du
 * Project. Les imports profonds restent interdits (carte `exports`).
 */

// Déclaration de types de contenu
export { defineContentType } from '../domain/content/declaration.js';
export type {
  ContentTypeDefinition,
  ContentTypeDeclaration,
  InferContentTypeData,
} from '../domain/content/declaration.js';
export {
  CONTENT_TYPE_KEY_PATTERN,
  ROUTE_NAMESPACE_PATTERN,
} from '../domain/content/declaration.js';

// Vocabulaire de champs
export { fields } from '../domain/content/fields.js';
export type {
  FieldDescriptor,
  TextFieldDescriptor,
  TextareaFieldDescriptor,
  RichTextFieldDescriptor,
  SelectFieldDescriptor,
  SelectChoice,
  UrlFieldDescriptor,
  DateFieldDescriptor,
  MetricFieldDescriptor,
  ListFieldDescriptor,
  FieldValue,
  FieldsData,
} from '../domain/content/fields.js';
export { dataSchemaFromFields } from '../domain/content/schema.js';

// Règles pures de slug (utiles au Project pour tester ses titres)
export {
  slugify,
  normalizeSlugInput,
  slugCandidates,
  resolveGeneratedSlug,
  SLUG_MAX_LENGTH,
} from '../domain/content/slug.js';

// Vue mutualisée preview/public
export { resolveContentViewModel, richTextFieldNames, collectRichTextMediaIds } from '../domain/content/view-model.js';
export type { ContentView, RichTextFieldView } from '../domain/content/view-model.js';

// Lecteur de build pour les pages publiques du Project (prérendu)
export { createContentReader } from './reader.js';
export type { ContentReader } from './reader.js';
