import { z } from 'zod';
import {
  LIST_DEFAULT_MAX_ITEMS,
  TEXTAREA_DEFAULT_MAX_LENGTH,
  TEXT_DEFAULT_MAX_LENGTH,
  URL_DEFAULT_MAX_LENGTH,
  type FieldDescriptor,
  type FieldsData,
} from './fields.js';

/**
 * Dérivation du schéma Zod strict d'un type de contenu depuis ses
 * descripteurs de champs (cadrage §8 — « schéma strict (Zod) du JSONB »).
 *
 * Une seule source de vérité : les descripteurs. `defineContentType` (côté
 * Project) et le registre runtime (côté Core, depuis le module virtuel)
 * appellent **la même fonction** — les validations Project et serveur ne
 * peuvent pas diverger. Le schéma est `strictObject` : une clé inconnue dans
 * le JSONB est une donnée corrompue, pas du contenu silencieusement accepté.
 */

function textSchema(descriptor: {
  kind: 'text';
  required?: boolean;
  maxLength?: number;
}): z.ZodType<string> {
  const maxLength = descriptor.maxLength ?? TEXT_DEFAULT_MAX_LENGTH;
  const schema = descriptor.required
    ? z.string().trim().min(1).max(maxLength)
    : z.string().trim().max(maxLength).optional();
  return schema as z.ZodType<string>;
}

function fieldSchema(descriptor: FieldDescriptor): z.ZodType<unknown> {
  switch (descriptor.kind) {
    case 'text':
      return textSchema(descriptor);
    case 'textarea': {
      const maxLength = descriptor.maxLength ?? TEXTAREA_DEFAULT_MAX_LENGTH;
      const schema = descriptor.required
        ? z.string().trim().min(1).max(maxLength)
        : z.string().trim().max(maxLength).optional();
      return schema as z.ZodType<unknown>;
    }
    case 'select': {
      // Zod 4 accepte un tableau readonly pour z.enum — la liste est fermée
      // par construction (valeurs déclarées en code).
      const values = descriptor.choices.map((choice) => choice.value);
      const schema = descriptor.required ? z.enum(values) : z.enum(values).optional();
      return schema as z.ZodType<unknown>;
    }
    case 'url': {
      const maxLength = descriptor.maxLength ?? URL_DEFAULT_MAX_LENGTH;
      const base = z
        .string()
        .trim()
        .max(maxLength)
        .pipe(z.url({ protocol: /^https?$/ }));
      const schema = descriptor.required ? base : base.optional();
      return schema as z.ZodType<unknown>;
    }
    case 'date': {
      const base = z.string().trim().pipe(z.iso.date());
      const schema = descriptor.required ? base : base.optional();
      return schema as z.ZodType<unknown>;
    }
    case 'metric': {
      const pair = z.strictObject({
        label: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(120),
      });
      const schema = descriptor.required ? pair : pair.optional();
      return schema as z.ZodType<unknown>;
    }
    case 'list': {
      const item = fieldSchema(descriptor.item);
      const minItems = descriptor.required ? 1 : 0;
      const maxItems = descriptor.maxItems ?? LIST_DEFAULT_MAX_ITEMS;
      // Un item optionnel absent/vide n'a pas de sens dans une liste : les
      // lignes vides du formulaire sont retirées par le parseur HTTP avant
      // la validation, le schéma ne voit que des items réels.
      const schema = z.array(item).min(minItems).max(maxItems);
      return (descriptor.required ? schema : schema.optional()) as z.ZodType<unknown>;
    }
  }
}

/**
 * Schéma du JSONB `data` pour un enregistrement de descripteurs — strict
 * (clé inconnue = invalide). Typé `FieldsData<F>` : l'inférence côté Project
 * vient de `defineContentType`, la validation runtime est identique.
 */
export function dataSchemaFromFields<F extends Record<string, FieldDescriptor>>(
  fields: F,
): z.ZodType<FieldsData<F>> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [name, descriptor] of Object.entries(fields)) {
    shape[name] = fieldSchema(descriptor);
  }
  // Un enregistrement vide reste valide : un type peut n'avoir que le titre
  // commun (title/slug) comme contenu.
  return z.strictObject(shape) as unknown as z.ZodType<FieldsData<F>>;
}
