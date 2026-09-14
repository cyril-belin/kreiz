import type { z } from 'zod';
import {
  contentLabelPlural,
  CONTENT_TYPE_KEY_MAX_LENGTH,
  CONTENT_TYPE_LABEL_MAX_LENGTH,
  CONTENT_TYPE_TEMPLATE_MAX_LENGTH,
  CONTENT_TYPE_KEY_PATTERN,
  ROUTE_NAMESPACE_MAX_LENGTH,
  ROUTE_NAMESPACE_PATTERN,
  type ContentTypeDeclaration,
} from './declaration.js';
import { UnknownContentTypeError } from './errors.js';
import { parseFieldsRecord, type FieldDescriptor, type FieldsData } from './fields.js';
import { dataSchemaFromFields } from './schema.js';

/**
 * Registre des types de contenu — le **seul** endroit où le Core connaît
 * les types déclarés (mission §8).
 *
 * Chaîne de production :
 *
 * ```text
 * Project → defineContentType() → kreiz({ content: { types: [...] } })
 *         → virtual:kreiz/config (données sérialisées + composants importés)
 *         → createContentTypeRegistry()
 * ```
 *
 * Le registre est une **fonction pure** : il revalide tout ce qu'il reçoit
 * (le module virtuel est généré depuis une config déjà validée, mais le
 * registre reste le point de vérité — y compris pour les tests unitaires,
 * qui construisent leurs propres entrées). Aucun Article/Guide/Case Study
 * n'est hardcodé dans le Core : un autre Project déclare « Services »,
 * « Équipe »… sans modifier Kreiz (mission §25).
 */

/** Composant de template Astro — importé par le module virtuel, opaqu côté Core. */
export type KreizTemplateComponent = Readonly<{
  (props: Record<string, unknown>, ...rest: unknown[]): unknown;
}>;

/**
 * Entrée d'entrée du registre : déclaration sérialisable + composant de
 * template résolu (le module virtuel attache le composant importé sous la
 * clé du type).
 */
export interface ContentTypeRegistryInput {
  readonly declarations: ReadonlyArray<ContentTypeDeclaration>;
  /** Clé = `key` du type ; valeur = composant .astro du Project. */
  readonly templates: Readonly<Record<string, unknown>>;
}

/** Déclaration résolue : données + composant + schéma dérivé (memoïsé). */
export interface ResolvedContentTypeDeclaration<
  F extends Record<string, FieldDescriptor> = Record<string, FieldDescriptor>,
> {
  readonly key: string;
  readonly label: string;
  readonly labelPlural: string;
  readonly routeNamespace: string;
  readonly fields: F;
  readonly template: KreizTemplateComponent;
  /** Schéma strict du JSONB `data` — dérivé par la même fonction que le Project. */
  readonly dataSchema: z.ZodType<FieldsData<F>>;
}

export interface ContentTypeRegistry {
  /** Tous les types déclarés, dans l'ordre de déclaration (navigation admin). */
  list(): readonly ResolvedContentTypeDeclaration[];
  findByKey(key: string): ResolvedContentTypeDeclaration | null;
  /** Résout par clé ou lève `UnknownContentTypeError` (jamais de rendu valide d'un type inconnu). */
  requireByKey(key: string): ResolvedContentTypeDeclaration;
  findByNamespace(namespace: string): ResolvedContentTypeDeclaration | null;
  /** L'identité namespace est unique — garanti à la construction du registre. */
  requireByNamespace(namespace: string): ResolvedContentTypeDeclaration;
}

function validateInputDeclaration(declaration: ContentTypeDeclaration, index: number): void {
  const where = `déclaration #${index}`;
  if (
    typeof declaration.key !== 'string' ||
    declaration.key.length < 1 ||
    declaration.key.length > CONTENT_TYPE_KEY_MAX_LENGTH ||
    !CONTENT_TYPE_KEY_PATTERN.test(declaration.key)
  ) {
    throw new Error(
      `@kreiz/core : ${where} — clé de type invalide (${JSON.stringify(declaration?.key)}).`,
    );
  }
  if (
    typeof declaration.label !== 'string' ||
    declaration.label.length < 1 ||
    declaration.label.length > CONTENT_TYPE_LABEL_MAX_LENGTH
  ) {
    throw new Error(
      `@kreiz/core : ${where} (« ${declaration.key} ») — label invalide.`,
    );
  }
  if (
    typeof declaration.routeNamespace !== 'string' ||
    declaration.routeNamespace.length < 1 ||
    declaration.routeNamespace.length > ROUTE_NAMESPACE_MAX_LENGTH ||
    !ROUTE_NAMESPACE_PATTERN.test(declaration.routeNamespace)
  ) {
    throw new Error(
      `@kreiz/core : ${where} (« ${declaration.key} ») — routeNamespace invalide (${JSON.stringify(declaration?.routeNamespace)}).`,
    );
  }
  if (
    typeof declaration.template !== 'string' ||
    declaration.template.length < 1 ||
    declaration.template.length > CONTENT_TYPE_TEMPLATE_MAX_LENGTH
  ) {
    throw new Error(
      `@kreiz/core : ${where} (« ${declaration.key} ») — template invalide (chemin du composant attendu).`,
    );
  }
  if (parseFieldsRecord(declaration.fields) === null) {
    throw new Error(
      `@kreiz/core : ${where} (« ${declaration.key} ») — champs non conformes au vocabulaire V1.`,
    );
  }
}

function isTemplateComponent(template: unknown): template is KreizTemplateComponent {
  // Un composant Astro compilé est une fonction (propriétés de factory en
  // prime). Accepter une fonction couvre les composants réels et les
  // doubles de test.
  return typeof template === 'function';
}

/**
 * Contraintes de croisement des déclarations — clés et namespaces uniques.
 * Pure : appelée par `createContentTypeRegistry` (runtime) et par
 * l'intégration dès la configuration (fail fast en Node, sans module
 * virtuel ni composants).
 */
export function validateDeclarationCrossConstraints(
  declarations: ReadonlyArray<ContentTypeDeclaration>,
): void {
  const byKey = new Map<string, ContentTypeDeclaration>();
  const byNamespace = new Map<string, ContentTypeDeclaration>();
  declarations.forEach((declaration, index) => {
    validateInputDeclaration(declaration, index);
    const previousKey = byKey.get(declaration.key);
    if (previousKey) {
      throw new Error(
        `@kreiz/core : clé de type de contenu dupliquée « ${declaration.key} » — chaque type doit avoir une clé unique.`,
      );
    }
    const previousNamespace = byNamespace.get(declaration.routeNamespace);
    if (previousNamespace) {
      throw new Error(
        `@kreiz/core : namespace de route dupliqué « ${declaration.routeNamespace} » (types « ${previousNamespace.key} » et « ${declaration.key} ») — chaque type doit avoir son namespace.`,
      );
    }
    byKey.set(declaration.key, declaration);
    byNamespace.set(declaration.routeNamespace, declaration);
  });
}

/**
 * Construit le registre — lève une `Error` claire (config Project fausse :
 * échec au démarrage du build/dev, jamais un état roulant silencieux) sur :
 * déclaration invalide, clé dupliquée, namespace dupliqué, template absent
 * ou non résolu.
 */
export function createContentTypeRegistry(input: ContentTypeRegistryInput): ContentTypeRegistry {
  validateDeclarationCrossConstraints(input.declarations ?? []);

  const byKey = new Map<string, ResolvedContentTypeDeclaration>();
  const byNamespace = new Map<string, ResolvedContentTypeDeclaration>();
  const list: ResolvedContentTypeDeclaration[] = [];

  (input.declarations ?? []).forEach((declaration) => {
    const template = input.templates?.[declaration.key];
    if (!isTemplateComponent(template)) {
      throw new Error(
        `@kreiz/core : template du type « ${declaration.key} » non résolu — le module virtuel doit fournir le composant déclaré (${declaration.template}).`,
      );
    }

    const resolved: ResolvedContentTypeDeclaration = {
      key: declaration.key,
      label: declaration.label,
      labelPlural: contentLabelPlural(declaration),
      routeNamespace: declaration.routeNamespace,
      fields: declaration.fields,
      template,
      dataSchema: dataSchemaFromFields(declaration.fields),
    };
    byKey.set(resolved.key, resolved);
    byNamespace.set(resolved.routeNamespace, resolved);
    list.push(resolved);
  });

  return {
    list: () => list,
    findByKey: (key) => byKey.get(key) ?? null,
    requireByKey: (key) => {
      const found = byKey.get(key);
      if (!found) throw new UnknownContentTypeError(key);
      return found;
    },
    findByNamespace: (namespace) => byNamespace.get(namespace) ?? null,
    requireByNamespace: (namespace) => {
      const found = byNamespace.get(namespace);
      if (!found) throw new UnknownContentTypeError(namespace);
      return found;
    },
  };
}
