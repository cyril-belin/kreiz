import type { z } from 'zod';
import {
  type FieldDescriptor,
  type FieldsData,
  fields as fieldBuilders,
  parseFieldsRecord,
} from './fields.js';
import { dataSchemaFromFields } from './schema.js';

/**
 * Déclaration d'un type de contenu — API publique du moteur (cadrage §8,
 * mission §3). **Déclarée en code par le Project**, jamais configurable
 * depuis l'UI : l'admin génère ses formulaires à partir des déclarations,
 * il ne les édite pas.
 *
 * ```ts
 * export const articleType = defineContentType({
 *   key: 'article',
 *   label: 'Article',
 *   labelPlural: 'Articles',
 *   routeNamespace: 'articles',          // → /articles/[slug]
 *   fields: {
 *     excerpt: fields.text({ label: 'Accroche', required: true }),
 *     body: fields.textarea({ label: 'Corps', required: true }),
 *   },
 *   template: 'src/templates/ArticleContent.astro',
 * });
 *
 * export type ArticleData = InferContentTypeData<typeof articleType>;
 * ```
 *
 * Le descripteur `dataSchema` est **dérivé** des champs (même fonction que
 * le runtime) : la validation Project et la validation serveur ne peuvent
 * pas diverger. Les champs système (titre, slug, statut, SEO) sont gérés
 * par le Core et n'appartiennent jamais aux déclarations.
 */

export const CONTENT_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
export const ROUTE_NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CONTENT_TYPE_KEY_MAX_LENGTH = 80;
export const CONTENT_TYPE_LABEL_MAX_LENGTH = 120;
export const ROUTE_NAMESPACE_MAX_LENGTH = 80;
export const CONTENT_TYPE_TEMPLATE_MAX_LENGTH = 1_024;

/**
 * Déclaration **résolue** telle que stockée/échangée — forme sérialisable
 * (le composant de template et le schéma dérivé sont attachés ailleurs :
 * composant via `virtual:kreiz/config`, schéma via `dataSchemaFromFields`).
 */
export interface ContentTypeDeclaration<F extends Record<string, FieldDescriptor> = Record<string, FieldDescriptor>> {
  /** Clé stable du type (`article`, `case_study`) — identité en base (`content_type`). */
  readonly key: string;
  readonly label: string;
  /** Libellé pluriel pour la navigation admin (défaut : label + « s »). */
  readonly labelPlural?: string;
  /** Namespace de route public (`articles` → `/articles/[slug]`). Imposé serveur. */
  readonly routeNamespace: string;
  /** Champs spécifiques du type — vocabulaire borné, sens structuré uniquement. */
  readonly fields: F;
  /**
   * Chemin du template **public** du Project (relatif à la racine du projet
   * Astro ou absolu). Résolu et importé par le Core via le module virtuel —
   * preview et rendu public partagent exactement le même composant.
   */
  readonly template: string;
}

/**
 * Déclaration **définie** par le Project : la déclaration sérialisable plus
 * le schéma Zod dérivé, pour le typage du Project
 * (`InferContentTypeData<typeof articleType>`).
 */
export interface ContentTypeDefinition<F extends Record<string, FieldDescriptor> = Record<string, FieldDescriptor>>
  extends ContentTypeDeclaration<F> {
  /** Schéma strict dérivé des champs — source unique Project/Core. */
  readonly dataSchema: z.ZodType<FieldsData<F>>;
}

/**
 * Type de données spécifiques d'une déclaration —
 * `type ArticleData = InferContentTypeData<typeof articleType>`.
 */
export type InferContentTypeData<D extends ContentTypeDefinition> = FieldsData<D['fields']>;

/**
 * Déclare un type de contenu. Valide la forme **à la définition** (fail fast
 * au chargement de la config, pas au premier rendu) : clé, namespace,
 * champs conformes au vocabulaire V1.
 */
export function defineContentType<F extends Record<string, FieldDescriptor>>(
  definition: ContentTypeDeclaration<F>,
): ContentTypeDefinition<F> {
  validateDeclarationShape(definition);
  return {
    key: definition.key,
    label: definition.label,
    labelPlural: definition.labelPlural,
    routeNamespace: definition.routeNamespace,
    fields: definition.fields,
    template: definition.template,
    dataSchema: dataSchemaFromFields(definition.fields),
  };
}

/** Valide la forme d'une déclaration — retourne la liste des erreurs FR. */
export function validateDeclarationShape(
  declaration: Pick<
    ContentTypeDeclaration,
    'key' | 'label' | 'labelPlural' | 'routeNamespace' | 'fields' | 'template'
  >,
): void {
  const problems: string[] = [];
  if (
    declaration.key.length < 1 ||
    declaration.key.length > CONTENT_TYPE_KEY_MAX_LENGTH ||
    !CONTENT_TYPE_KEY_PATTERN.test(declaration.key)
  ) {
    problems.push(
      `clé invalide « ${String(declaration.key)} » (attendu : minuscules/chiffres/underscore, commençant par une lettre)`,
    );
  }
  if (
    declaration.label.length < 1 ||
    declaration.label.length > CONTENT_TYPE_LABEL_MAX_LENGTH
  ) {
    problems.push('label requis (1–120 caractères)');
  }
  if (
    declaration.labelPlural !== undefined &&
    (declaration.labelPlural.length < 1 || declaration.labelPlural.length > CONTENT_TYPE_LABEL_MAX_LENGTH)
  ) {
    problems.push('labelPlural invalide (1–120 caractères)');
  }
  if (
    declaration.routeNamespace.length < 1 ||
    declaration.routeNamespace.length > ROUTE_NAMESPACE_MAX_LENGTH ||
    !ROUTE_NAMESPACE_PATTERN.test(declaration.routeNamespace)
  ) {
    problems.push(
      `namespace de route invalide « ${String(declaration.routeNamespace)} » (attendu : segments minuscules séparés par des tirets)`,
    );
  }
  if (
    declaration.template.length < 1 ||
    declaration.template.length > CONTENT_TYPE_TEMPLATE_MAX_LENGTH
  ) {
    problems.push('template requis (chemin du composant Astro public du Project)');
  }
  if (parseFieldsRecord(declaration.fields) === null) {
    problems.push('champs non conformes au vocabulaire V1 (kind inconnu, options invalides…)');
  }
  if (problems.length > 0) {
    throw new Error(
      `@kreiz/core : déclaration de type de contenu invalide (« ${declaration.key} ») — ${problems.join(' ; ')}.`,
    );
  }
}

/**
 * Étiquette plurielle par défaut — le Core n'impose pas l'anglais :
 * sans `labelPlural`, « s » est ajouté (français courant : Article → Articles).
 * Le demo déclare explicitement ses pluriels.
 */
export function contentLabelPlural(declaration: {
  label: string;
  labelPlural?: string;
}): string {
  return declaration.labelPlural ?? `${declaration.label}s`;
}

/** Ré-export des builders pour l'API publique (`@kreiz/core/content`). */
export { fieldBuilders as fields };
