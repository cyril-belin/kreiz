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
 */

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
  /** Données structurées à valider par le schéma du type (champs vides omis). */
  data: Record<string, unknown>;
  /** Valeurs brutes par champ (re-rendu fidèle). */
  values: Record<string, FormFieldValue>;
  /** Erreurs structurelles (requis vide, paire incomplète) — la validation métier reste au service. */
  errors: ContentFieldErrors;
};

const REQUIRED_FIELD_ERROR = 'Ce champ est requis.';
const INCOMPLETE_METRIC_ERROR = 'Chaque ligne doit avoir un libellé et une valeur.';

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

  return {
    title: stringEntry(formData, 'title'),
    slug: stringEntry(formData, 'slug'),
    data,
    values,
    errors,
  };
}
