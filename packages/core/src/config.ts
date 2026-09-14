import { z } from 'zod';
import type { FieldDescriptor } from './domain/content/fields.js';
import {
  CONTENT_TYPE_KEY_MAX_LENGTH,
  CONTENT_TYPE_LABEL_MAX_LENGTH,
  CONTENT_TYPE_TEMPLATE_MAX_LENGTH,
  CONTENT_TYPE_KEY_PATTERN,
  ROUTE_NAMESPACE_MAX_LENGTH,
  ROUTE_NAMESPACE_PATTERN,
} from './domain/content/declaration.js';
import { parseFieldsRecord } from './domain/content/fields.js';

/**
 * Configuration fournie par l'application consommatrice à l'intégration Astro
 * (cadrage §8 — « un type de contenu est déclaré en code par le projet »).
 *
 * ```ts
 * // astro.config.ts
 * kreiz({ content: { types: [articleType, guideType, caseStudyType] } })
 * ```
 *
 * Chaque déclaration est revalidée ici (fail fast au chargement de la
 * config). La propriété `dataSchema` des définitions du Project est
 * explicitement tolérée puis **abandonnée** : le schéma est dérivé une
 * seconde fois côté runtime par la même fonction pure — la partie
 * sérialisée vers le module virtuel ne transporte que la source de vérité
 * (descripteurs + chemin de template). Toute autre clé inconnue est rejetée :
 * la configuration n'est jamais silencieusement ignorée.
 */

const contentTypeDeclarationSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(CONTENT_TYPE_KEY_MAX_LENGTH)
    .regex(CONTENT_TYPE_KEY_PATTERN),
  label: z.string().min(1).max(CONTENT_TYPE_LABEL_MAX_LENGTH),
  labelPlural: z.string().min(1).max(CONTENT_TYPE_LABEL_MAX_LENGTH).optional(),
  routeNamespace: z
    .string()
    .min(1)
    .max(ROUTE_NAMESPACE_MAX_LENGTH)
    .regex(ROUTE_NAMESPACE_PATTERN),
  fields: z.unknown().transform((value, ctx) => {
    const parsed = parseFieldsRecord(value);
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: 'champs non conformes au vocabulaire V1' });
      return z.NEVER;
    }
    return parsed;
  }),
  template: z.string().min(1).max(CONTENT_TYPE_TEMPLATE_MAX_LENGTH),
  // Propriété du Project (`defineContentType` attache le schéma dérivé) —
  // non sérialisée, dérivée à nouveau côté runtime. Slot explicite : la
  // présence de cette clé n'est pas une clé inconnue.
  dataSchema: z.unknown().optional(),
});

export const kreizConfigSchema = z.strictObject({
  content: z
    .strictObject({
      /** Types de contenu déclarés par le Project (ordre = ordre de navigation). */
      types: z.array(contentTypeDeclarationSchema).max(100),
    })
    .optional(),
});

/**
 * Configuration normalisée — forme sérialisée vers `virtual:kreiz/config`.
 * `dataSchema` est retiré des déclarations (dérivé côté runtime).
 */
export type KreizConfig = {
  content?: {
    types: Array<{
      key: string;
      label: string;
      labelPlural?: string;
      routeNamespace: string;
      fields: Record<string, FieldDescriptor>;
      template: string;
    }>;
  };
};

export function normalizeKreizConfig(input: unknown): KreizConfig {
  const parsed = kreizConfigSchema.parse(input ?? {}) as {
    content?: { types: Array<Record<string, unknown>> };
  };
  if (!parsed.content) return {};
  return {
    content: {
      types: parsed.content.types.map((type) => ({
        key: type.key as string,
        label: type.label as string,
        labelPlural: type.labelPlural as string | undefined,
        routeNamespace: type.routeNamespace as string,
        fields: type.fields as Record<string, FieldDescriptor>,
        template: type.template as string,
      })),
    },
  };
}
