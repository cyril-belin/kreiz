import type { ContentFieldErrors } from '../services/content.js';
import type { ResolvedContentTypeDeclaration } from '../domain/content/registry.js';

/**
 * Parseur HTTP des formulaires de contenu (cadrage §16, mission §19).
 *
 * Sécurité par **whitelist stricte** : seuls le titre, le slug optionnel et
 * les champs déclarés du type sont lus. Toute autre entrée POSTée
 * (`content_type`, `route_namespace`, `status`, `created_by`, champs
 * inconnus…) est ignorée — le type et le namespace sont résolus côté
 * serveur depuis l'URL et le registre, l'acteur vient du guard de session.
 * Le parseur structure ; la validation métier (requis effectifs, bornes,
 * formats) appartient au schéma Zod dérivé, dans le service.
 *
 * Formulaires HTML progressifs (aucun JavaScript) :
 * - liste de textes = plusieurs `<input name="champ">` (reçus via getAll) ;
 * - métrique = paire `<input name="champ:label">` / `<input name="champ:value">` ;
 * - liste de métriques = lignes fixes de paires ; les lignes entièrement
 *   vides sont ignorées, une paire incomplète est une erreur de champ.
 *
 * Rich text (slice 6) : le champ voyage en `<input type="hidden">` portant
 * le JSON du document — rempli par le serveur (état stocké) et synchronisé
 * par l'îlot Tiptap à la soumission. Sans JavaScript, la valeur serveur
 * repart **inchangée** : le formulaire ne corrompt jamais un document
 * existant. Le parseur ne fait que délimiter le JSON ; la validation du
 * document (version, nodes/marks, liens, bornes) reste au schéma du domaine.
 */

import { RichTextDocumentError, richTextDocumentErrorMessage } from '../domain/content/rich-text/errors.js';
import { parseRichTextDocument } from '../domain/content/rich-text/document.js';

/** Valeur brute d'un champ, pour re-rendre le formulaire tel que saisi. */
export type FormFieldValue =
  | { kind: 'string'; value: string }
  | { kind: 'metric'; label: string; value: string }
  | { kind: 'list-string'; items: string[] }
  | { kind: 'list-metric'; items: Array<{ label: string; value: string }> };

export type ParsedContentForm = {
  /** Titre brut saisi (re-rendu en cas d'erreur). */
  title: string;
  /** Slug brut saisi ('' = généré à la création). */
  slug: string;
  /**
   * Couverture saisie — **champ système** (mission §27 : jamais dans `data`).
   * `null` = aucune (« Aucune »), `string` = id de média prêt.
   */
  coverMediaId: string | null;
  /**
   * SEO brut saisi (slice 9) — **champ système** (jamais dans `data`) :
   * structure avant validation ; le service valide (bornes, formats, média
   * existant) et normalise. Les booléens partagent la sémantique checkbox
   * (présents true/false — décocher retire).
   */
  seo: Record<string, unknown>;
  /** Données structurées à valider par le schéma du type (champs vides omis). */
  data: Record<string, unknown>;
  /**
   * **Concurrence optimiste** (passe de fermeture) — champ système
   * `expected_updated_at` rendu par la page d'édition (ISO brut, `''` si
   * absent). Le service décide : garde conditionnelle ou flux historique.
   */
  expectedUpdatedAt: string;
  /** Valeurs brutes par champ (re-rendu fidèle). */
  values: Record<string, FormFieldValue>;
  /** Erreurs structurelles (requis vide, paire incomplète) — la validation métier reste au service. */
  errors: ContentFieldErrors;
};

const REQUIRED_FIELD_ERROR = 'Ce champ est requis.';
const INCOMPLETE_METRIC_ERROR = 'Chaque ligne doit avoir un libellé et une valeur.';
const UNREADABLE_RICH_TEXT_ERROR =
  'Document illisible — rechargez la page pour restaurer le contenu enregistré (rien n’a été modifié).';

function stringEntry(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse le formulaire d'un type déclaré — voir la doc du module. */
export function parseContentForm(
  declaration: Pick<ResolvedContentTypeDeclaration, 'fields'>,
  formData: FormData,
): ParsedContentForm {
  const errors: ContentFieldErrors = {};
  const data: Record<string, unknown> = {};
  const values: Record<string, FormFieldValue> = {};

  for (const [name, descriptor] of Object.entries(declaration.fields)) {
    switch (descriptor.kind) {
      case 'text':
      case 'textarea':
      case 'url':
      case 'date':
      case 'select': {
        const value = stringEntry(formData, name);
        values[name] = { kind: 'string', value };
        if (value.length > 0) {
          data[name] = value;
        } else if (descriptor.required) {
          errors[name] = REQUIRED_FIELD_ERROR;
        }
        break;
      }

      case 'richText': {
        // JSON brut du document (pas de trim : le JSON peut finir par un
        // saut de ligne légitime). Vide = champ vide ; le JSON est ensuite
        // validé par le schéma du domaine (version, nodes, marks, liens,
        // bornes) — le parseur ne décide jamais de la validité éditoriale.
        const raw = formData.get(name);
        const value = typeof raw === 'string' ? raw : '';
        values[name] = { kind: 'string', value };
        if (value.trim().length === 0) {
          if (descriptor.required) {
            errors[name] = REQUIRED_FIELD_ERROR;
          }
          break;
        }
        try {
          data[name] = parseRichTextDocument(JSON.parse(value));
        } catch (error) {
          if (error instanceof SyntaxError) {
            errors[name] = UNREADABLE_RICH_TEXT_ERROR;
          } else if (error instanceof RichTextDocumentError) {
            errors[name] = richTextDocumentErrorMessage(error);
          } else {
            throw error;
          }
        }
        break;
      }

      case 'metric': {
        const label = stringEntry(formData, `${name}:label`);
        const value = stringEntry(formData, `${name}:value`);
        values[name] = { kind: 'metric', label, value };
        if (label.length > 0 || value.length > 0) {
          if (label.length === 0 || value.length === 0) {
            errors[name] = INCOMPLETE_METRIC_ERROR;
          } else {
            data[name] = { label, value };
          }
        } else if (descriptor.required) {
          errors[name] = REQUIRED_FIELD_ERROR;
        }
        break;
      }

      case 'list': {
        const item = descriptor.item;
        if (item.kind === 'text') {
          const items = formData
            .getAll(name)
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter((entry) => entry.length > 0);
          values[name] = { kind: 'list-string', items };
          if (items.length > 0) {
            data[name] = items;
          } else if (descriptor.required) {
            errors[name] = REQUIRED_FIELD_ERROR;
          }
        } else {
          // Liste de métriques : paires alignées par index de soumission.
          const labels = formData
            .getAll(`${name}:label`)
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
          const values2 = formData
            .getAll(`${name}:value`)
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
          const rows: Array<{ label: string; value: string }> = [];
          let incomplete = false;
          const rowCount = Math.max(labels.length, values2.length);
          for (let index = 0; index < rowCount; index += 1) {
            const label = labels[index] ?? '';
            const value = values2[index] ?? '';
            if (label.length === 0 && value.length === 0) continue;
            if (label.length === 0 || value.length === 0) {
              incomplete = true;
              rows.push({ label, value });
            } else {
              rows.push({ label, value });
            }
          }
          values[name] = { kind: 'list-metric', items: rows };
          if (incomplete) {
            errors[name] = INCOMPLETE_METRIC_ERROR;
          }
          const complete = rows.filter((row) => row.label.length > 0 && row.value.length > 0);
          if (complete.length > 0) {
            data[name] = complete;
          } else if (descriptor.required && rows.length === 0) {
            errors[name] ??= REQUIRED_FIELD_ERROR;
          }
        }
        break;
      }
    }
  }

  // Valeurs SEO brutes (slice 9) — champs système whitelistés, nommés
  // `seo_*` : tout autre champ non déclaré reste ignoré. Le service valide
  // (schéma strict, média existant, origine canonique) et normalise.
  const seo: Record<string, unknown> = {};
  const seoTitle = stringEntry(formData, 'seo_title');
  if (seoTitle.length > 0) seo.title = seoTitle;
  const seoDescription = stringEntry(formData, 'seo_description');
  if (seoDescription.length > 0) seo.description = seoDescription;
  const seoCanonical = stringEntry(formData, 'seo_canonical');
  if (seoCanonical.length > 0) seo.canonicalOverride = seoCanonical;
  const seoOgTitle = stringEntry(formData, 'seo_og_title');
  if (seoOgTitle.length > 0) seo.ogTitle = seoOgTitle;
  const seoOgDescription = stringEntry(formData, 'seo_og_description');
  if (seoOgDescription.length > 0) seo.ogDescription = seoOgDescription;
  const seoOgImage = stringEntry(formData, 'seo_og_image_media_id');
  if (seoOgImage.length > 0) seo.ogImageMediaId = seoOgImage;
  // Checkboxes : `on` quand cochées, absentes sinon — `false` explicite
  // pour que décocher retire bien le noindex.
  seo.noindex = formData.get('seo_noindex') === 'on';
  seo.nofollow = formData.get('seo_nofollow') === 'on';

  return {
    title: stringEntry(formData, 'title'),
    slug: stringEntry(formData, 'slug'),
    // Champ système whitelisté (slice 5) — le service valide l'existence du
    // média ; tout autre champ non déclaré reste ignoré.
    coverMediaId: stringEntry(formData, 'cover_media_id') || null,
    // Champ système whitelisté (passe de fermeture) — version attendue du
    // contenu rendue par la page d'édition (concurrence optimiste).
    expectedUpdatedAt: stringEntry(formData, 'expected_updated_at'),
    seo,
    data,
    values,
    errors,
  };
}
