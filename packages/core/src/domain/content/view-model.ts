import type { z } from 'zod';
import type {
  KreizContentEntry,
  KreizContentSeo,
  KreizContentStatus,
} from '../../data/tables/content-entries.js';
import type { PublicMediaView } from '../media/view-model.js';
import type { FieldDescriptor } from './fields.js';
import {
  extractRichTextMediaIds,
  type KreizRichTextDocument,
} from './rich-text/document.js';
import { renderRichTextDocument } from './rich-text/render.js';
import { ContentDataCorruptedError, UnknownContentTypeError } from './errors.js';

/**
 * Vue d'un champ richText résolue (slice 6) : le document canonique validé et
 * son HTML **déjà rendu** par le renderer déterministe du domaine (seule
 * source autorisée d'un `set:html` côté templates — tout le texte y est
 * échappé, les tags et attributs sont ceux du renderer).
 */
export interface RichTextFieldView {
  readonly document: KreizRichTextDocument;
  readonly html: string;
}

/**
 * Vue de contenu **mutualisée** (mission §23) : le mapping entrée DB → props
 * de template est unique. La preview SSR (`/admin/preview/[id]`) et le rendu
 * public (build Astro des pages du Project) appellent le même
 * `resolveContentViewModel` et passent **exactement les mêmes données
 * structurées** au **même composant** de template du Project. Aucun
 * renderer de preview parallèle.
 *
 * `cover` (slice 5) : la vue publique du média de couverture — `ready`
 * uniquement (mission §29), résolue par l'appelant (service de contenu pour
 * la preview, lecteur de build pour le public) qui passe la vue déjà
 * résolue en option. `null` = pas de couverture (ou couverture non prête en
 * preview — jamais rendue comme image valide).
 *
 * `richText` (slice 6) : vues des champs richText déclarés, clés par nom de
 * champ. Les médias référencés sont résolus **batch** par l'appelant (option
 * `richTextMedia`) et injectés dans le rendu ; une référence absente de la
 * carte est une corruption — erreur explicite, jamais un rendu silencieux
 * (même contrat que la couverture).
 */
export interface ContentView<TData> {
  readonly id: string;
  readonly contentType: string;
  readonly routeNamespace: string;
  readonly title: string;
  readonly slug: string;
  readonly status: KreizContentStatus;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
  readonly createdAt: Date;
  readonly seo: KreizContentSeo;
  /** Couverture résolue (`ready` uniquement), ou `null`. */
  readonly cover: PublicMediaView | null;
  /** Vues des champs richText déclarés (clé = nom du champ). */
  readonly richText: Readonly<Record<string, RichTextFieldView>>;
  /** Données spécifiques du type, validées par le schéma de la déclaration. */
  readonly data: TData;
}

/** Noms des champs richText d'un enregistrement de descripteurs. */
export function richTextFieldNames(
  fields: Record<string, FieldDescriptor> | undefined,
): string[] {
  if (!fields) return [];
  return Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'richText')
    .map(([name]) => name);
}

/**
 * Collecte les ids médias référencés par les champs richText de données
 * **déjà validées** — pour la résolution batch (une requête par build/page,
 * pas par document).
 */
export function collectRichTextMediaIds(
  fields: Record<string, FieldDescriptor> | undefined,
  data: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const name of richTextFieldNames(fields)) {
    const value = data[name];
    if (value === undefined || value === null || typeof value !== 'object') continue;
    for (const id of extractRichTextMediaIds(value as KreizRichTextDocument)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

type ContentEntryLike = Pick<
  KreizContentEntry,
  | 'id'
  | 'contentType'
  | 'routeNamespace'
  | 'title'
  | 'slug'
  | 'status'
  | 'publishedAt'
  | 'updatedAt'
  | 'createdAt'
  | 'seo'
  | 'data'
>;

/**
 * Résout la vue typée d'une entrée :
 * 1. `content_type` de l'entrée = clé de la déclaration (une entrée n'est
 *    jamais rendue sous un autre type — isolation des types, mission §35) ;
 * 2. `route_namespace` cohérent avec la déclaration (imposé serveur) ;
 * 3. `data` validé par le schéma strict du type — une entrée en base avec
 *    un type inconnu ou des données invalides lève une erreur de domaine
 *    propre, jamais un rendu silencieux de contenu invalide (mission §4) ;
 * 4. champs richText rendus via le renderer déterministe, médias injectés
 *    depuis la carte `richTextMedia` (absence = corruption, mission §29).
 */
export function resolveContentViewModel<TData>(
  declaration: {
    key: string;
    routeNamespace: string;
    dataSchema: z.ZodType<TData>;
    fields?: Record<string, FieldDescriptor>;
  },
  entry: ContentEntryLike,
  options: {
    cover?: PublicMediaView | null;
    /** Vues publiques des médias référencés par les champs richText. */
    richTextMedia?: ReadonlyMap<string, PublicMediaView>;
    /**
     * `true` (défaut — build public) : une référence non résolue est une
     * corruption → erreur explicite. `false` (admin : édition, preview —
     * même sémantique que la couverture non prête, mission §29) : la figure
     * n'est pas rendue, l'édition reste possible.
     */
    richTextStrict?: boolean;
  } = {},
): ContentView<TData> {
  if (entry.contentType !== declaration.key) {
    throw new UnknownContentTypeError(
      `${entry.contentType} (entrée ${entry.id}, attendu « ${declaration.key} »)`,
    );
  }
  if (entry.routeNamespace !== declaration.routeNamespace) {
    throw new ContentDataCorruptedError(
      entry.id,
      `route_namespace « ${entry.routeNamespace} » incohérent avec la déclaration « ${declaration.routeNamespace} »`,
    );
  }
  const parsed = declaration.dataSchema.safeParse(entry.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join('.') || '(racine)'} : ${issue.message}` : 'schéma invalide';
    throw new ContentDataCorruptedError(entry.id, `data invalid — ${detail}`);
  }
  const richText = resolveRichTextViews(
    declaration.fields,
    parsed.data,
    options.richTextMedia,
    entry.id,
    options.richTextStrict ?? true,
  );
  return {
    id: entry.id,
    contentType: entry.contentType,
    routeNamespace: entry.routeNamespace,
    title: entry.title,
    slug: entry.slug,
    status: entry.status,
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    seo: entry.seo,
    cover: options.cover ?? null,
    richText,
    data: parsed.data,
  };
}

/**
 * Rend les vues des champs richText — HTML déterministe du domaine, médias
 * résolus par l'appelant. En mode strict (public) une référence non résolue
 * est une divergence entre snapshot et médiathèque (suppression hors
 * service…) : corruption explicite, jamais un rendu silencieux d'une image
 * absente. En mode admin, la figure est simplement omise (un média non
 * prêt n'a pas d'URL publique — rien de rendable honnêtement).
 */
function resolveRichTextViews<TData>(
  fields: Record<string, FieldDescriptor> | undefined,
  data: TData,
  mediaMap: ReadonlyMap<string, PublicMediaView> | undefined,
  entryId: string,
  strict: boolean,
): Readonly<Record<string, RichTextFieldView>> {
  const names = richTextFieldNames(fields);
  if (names.length === 0) return {};
  const record: Record<string, RichTextFieldView> = {};
  const dataRecord = data as Record<string, unknown>;
  for (const name of names) {
    const document = dataRecord[name] as KreizRichTextDocument | undefined;
    if (!document) continue;
    if (strict) {
      const unresolved = collectRichTextMediaIds(
        { [name]: fields![name]! },
        dataRecord,
      ).filter((id) => !mediaMap?.has(id));
      if (unresolved.length > 0) {
        throw new ContentDataCorruptedError(
          entryId,
          `média référencé par le rich text « ${name} » absent ou non prêt (${unresolved[0]})`,
        );
      }
    }
    record[name] = {
      document,
      html: renderRichTextDocument(document, {
        resolveMedia: (id) => mediaMap?.get(id) ?? null,
      }),
    };
  }
  return record;
}
