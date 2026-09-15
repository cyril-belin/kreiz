import { z } from 'zod';
import type { KreizRichTextDocument } from './rich-text/document.js';

/**
 * Vocabulaire de champs V1 du moteur de contenu (cadrage §8, mission §5).
 *
 * Un descripteur de champ est une **donnée pure et sérialisable** : c'est la
 * source de vérité unique dont le Core dérive à la fois le schéma Zod de
 * validation serveur (`dataSchemaFromFields`), le formulaire admin et le
 * typage du `data` JSONB (`InferFieldValueType`). Le Project ne fournit
 * jamais de schéma Zod à la main : il décrit le **sens** des champs, jamais
 * leur rendu (aucune classe CSS, aucune variante de layout — principe §1).
 *
 * V1 — volontairement borné :
 * - `text` : texte court ;
 * - `textarea` : texte long simple (reste valable — le rich text ne le
 *   remplace pas, voir slice 6) ;
 * - `richText` : document structuré canonique Kreiz (slice 6 — édité par
 *   Tiptap côté admin, rendu par le renderer déterministe côté public) ;
 * - `select` : liste fermée déclarée en code ;
 * - `url` : URL absolue http(s) validée ;
 * - `date` : date ISO `YYYY-MM-DD` ;
 * - `metric` : paire label/valeur ;
 * - `list` : liste simple typée (items `text` ou `metric`).
 *
 * Hors périmètre du slice 3 (arriveront avec leurs slices, sans casser les
 * déclarations existantes) : `media` (slice 5, champ système), relations et
 * blocks libres.
 */

// ——— Descripteurs ———

export interface FieldCommonOptions {
  /** Libellé affiché dans le formulaire admin. */
  label: string;
  /** Aide contextuelle (texte court, rendu sous le champ). */
  help?: string;
  /**
   * Champ obligatoire. Un champ optionnel laissé vide est **omis** du `data`
   * stocké (pas de chaîne vide en base).
   */
  required?: boolean;
}

export interface TextFieldDescriptor extends FieldCommonOptions {
  kind: 'text';
  /** Longueur maximale (défaut 200). */
  maxLength?: number;
  placeholder?: string;
}

export interface TextareaFieldDescriptor extends FieldCommonOptions {
  kind: 'textarea';
  /** Longueur maximale (défaut 20 000 — borne anti-abus, pas une règle éditoriale). */
  maxLength?: number;
}

/**
 * Document riche structuré (slice 6) — format canonique Kreiz
 * (`RichTextDocument`, voir `domain/content/rich-text/`). La valeur stockée
 * dans `data` est un **objet document validé** (version, nodes et marks
 * whitelistés) — jamais du HTML. Les bornes (taille, profondeur, liens)
 * appartiennent à la politique du format, pas au descripteur : le descripteur
 * ne porte que du sens éditorial.
 */
export interface RichTextFieldDescriptor extends FieldCommonOptions {
  kind: 'richText';
}

export interface SelectChoice<C extends string = string> {
  value: C;
  label: string;
}

export interface SelectFieldDescriptor<C extends string = string> extends FieldCommonOptions {
  kind: 'select';
  /** Liste fermée — déclarée en code, jamais éditable depuis l'admin. */
  choices: ReadonlyArray<SelectChoice<C>>;
}

export interface UrlFieldDescriptor extends FieldCommonOptions {
  kind: 'url';
  maxLength?: number;
  placeholder?: string;
}

export interface DateFieldDescriptor extends FieldCommonOptions {
  kind: 'date';
}

/** Paire label/valeur — métrique simple (résultat de mission, chiffre clé…). */
export interface MetricFieldDescriptor extends FieldCommonOptions {
  kind: 'metric';
}

/**
 * Liste simple typée. V1 : les items sont des descripteurs **scalaires**
 * (`text` ou `metric`) — pas de listes de listes ni de blocks. Formulaires
 * progressifs sans JavaScript : les items sont rendus en lignes fixes.
 */
export interface ListFieldDescriptor<I extends FieldDescriptor = FieldDescriptor>
  extends FieldCommonOptions {
  kind: 'list';
  item: I;
  /** Nombre maximal d'items (défaut 20, borne anti-abus). */
  maxItems?: number;
}

export type FieldDescriptor =
  | TextFieldDescriptor
  | TextareaFieldDescriptor
  | RichTextFieldDescriptor
  | SelectFieldDescriptor
  | UrlFieldDescriptor
  | DateFieldDescriptor
  | MetricFieldDescriptor
  | ListFieldDescriptor;

// ——— Typage des valeurs ———

/**
 * Type de valeur stockée dans le JSONB `data` pour un descripteur donné.
 * Inférence utilisée par `defineContentType` : `content_type = article` ⇒
 * `data = ArticleData`, sans `Record<string, unknown>` côté Project.
 */
export type FieldValue<D> = D extends ListFieldDescriptor<infer I>
  ? FieldValue<I>[]
  : D extends SelectFieldDescriptor<infer C>
    ? C
    : D extends MetricFieldDescriptor
      ? { label: string; value: string }
      : D extends RichTextFieldDescriptor
        ? KreizRichTextDocument
        : string;

/** Mapping `data` complet dérivé d'un enregistrement de descripteurs. */
export type FieldsData<F extends Record<string, FieldDescriptor>> = {
  [K in keyof F]: FieldValue<F[K]>;
};

// ——— Bornes de validation ———

export const TEXT_DEFAULT_MAX_LENGTH = 200;
export const TEXTAREA_DEFAULT_MAX_LENGTH = 20_000;
export const URL_DEFAULT_MAX_LENGTH = 2_048;
export const LIST_DEFAULT_MAX_ITEMS = 20;

// ——— Builders ———

/**
 * Helpers de déclaration — `fields.text(…)`, `fields.select(…)`… Le `kind`
 * est posé par le builder : les déclarations du Project ne portent que du
 * sens (label, aide, requis, bornes). Ils ne construisent pas un système de
 * formulaire universel : chaque descripteur ne porte que ce dont Kreiz a
 * besoin, et le vocabulaire reste extensible (slice 5/6 : media, richText)
 * sans casser les types existants.
 */
export const fields = {
  text(options: Omit<TextFieldDescriptor, 'kind'>): TextFieldDescriptor {
    return { kind: 'text', ...options };
  },
  textarea(options: Omit<TextareaFieldDescriptor, 'kind'>): TextareaFieldDescriptor {
    return { kind: 'textarea', ...options };
  },
  richText(options: Omit<RichTextFieldDescriptor, 'kind'>): RichTextFieldDescriptor {
    return { kind: 'richText', ...options };
  },
  select<C extends string>(options: Omit<SelectFieldDescriptor<C>, 'kind'>): SelectFieldDescriptor<C> {
    return { kind: 'select', ...options };
  },
  url(options: Omit<UrlFieldDescriptor, 'kind'>): UrlFieldDescriptor {
    return { kind: 'url', ...options };
  },
  date(options: Omit<DateFieldDescriptor, 'kind'>): DateFieldDescriptor {
    return { kind: 'date', ...options };
  },
  metric(options: Omit<MetricFieldDescriptor, 'kind'>): MetricFieldDescriptor {
    return { kind: 'metric', ...options };
  },
  list<I extends FieldDescriptor>(options: Omit<ListFieldDescriptor<I>, 'kind'>): ListFieldDescriptor<I> {
    return { kind: 'list', ...options };
  },
};

// ——— Validation de forme (config-time et runtime) ———

const fieldCommonShape = {
  label: z.string().min(1).max(200),
  help: z.string().min(1).max(500).optional(),
  required: z.boolean().optional(),
};

/**
 * Schéma Zod d'un descripteur de champ — sert deux fois : validation de la
 * configuration Project (fail fast au chargement d'astro.config) et
 * revalidation du module virtuel côté runtime (le registre ne fait jamais
 * confiance à une forme non vérifiée).
 */
export const fieldDescriptorSchema: z.ZodType<FieldDescriptor> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('text'),
      ...fieldCommonShape,
      maxLength: z.number().int().min(1).max(10_000).optional(),
      placeholder: z.string().min(1).max(200).optional(),
    }),
    z.strictObject({
      kind: z.literal('textarea'),
      ...fieldCommonShape,
      maxLength: z.number().int().min(1).max(100_000).optional(),
    }),
    z.strictObject({ kind: z.literal('richText'), ...fieldCommonShape }),
    z.strictObject({
      kind: z.literal('select'),
      ...fieldCommonShape,
      choices: z
        .array(
          z.strictObject({
            value: z.string().min(1).max(120),
            label: z.string().min(1).max(200),
          }),
        )
        .min(1)
        .max(100),
    }),
    z.strictObject({
      kind: z.literal('url'),
      ...fieldCommonShape,
      maxLength: z.number().int().min(1).max(4_096).optional(),
      placeholder: z.string().min(1).max(500).optional(),
    }),
    z.strictObject({ kind: z.literal('date'), ...fieldCommonShape }),
    z.strictObject({ kind: z.literal('metric'), ...fieldCommonShape }),
    z.strictObject({
      kind: z.literal('list'),
      ...fieldCommonShape,
      item: z.union([
        z.strictObject({
          kind: z.literal('text'),
          ...fieldCommonShape,
          maxLength: z.number().int().min(1).max(10_000).optional(),
        }),
        z.strictObject({
          kind: z.literal('metric'),
          ...fieldCommonShape,
        }),
      ]),
      maxItems: z.number().int().min(1).max(100).optional(),
    }),
  ]),
) as z.ZodType<FieldDescriptor>;

const FIELD_NAME_SCHEMA = z.string().min(1).max(80);
const MAX_FIELDS_PER_TYPE = 60;

/** Vérifie qu'un enregistrement de champs est conforme au vocabulaire V1. */
export function parseFieldsRecord(input: unknown): Record<string, FieldDescriptor> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_FIELDS_PER_TYPE) return null;
  const parsed = z.record(FIELD_NAME_SCHEMA, fieldDescriptorSchema).safeParse(input);
  return parsed.success ? (parsed.data as Record<string, FieldDescriptor>) : null;
}
