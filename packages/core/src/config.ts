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
import {
  type ContactFieldDescriptor,
  parseContactFieldsRecord,
} from './domain/forms/fields.js';
import {
  CONTACT_KEY_MAX_LENGTH,
  CONTACT_KEY_PATTERN,
  CONTACT_LABEL_MAX_LENGTH,
  CONTACT_DESCRIPTION_MAX_LENGTH,
  CONTACT_NOTIFICATION_SUBJECT_MAX_LENGTH,
  CONTACT_RECIPIENTS_MAX,
  isInternalConfirmationPath,
  isSafeEmailAddress,
  isSafeHeaderValue,
} from './domain/forms/policy.js';

/**
 * Configuration fournie par l'application consommatrice à l'intégration Astro
 * (cadrage §8 — « un type de contenu est déclaré en code par le projet »).
 *
 * ```ts
 * // astro.config.ts
 * kreiz({
 *   content: { types: [articleType, guideType, caseStudyType] },
 *   forms: [contactForm],
 * })
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

/**
 * Déclaration de formulaire sérialisée — miroir de revalidation de
 * `defineContactForm` (fail fast au chargement de la config). La propriété
 * `payloadSchema` (attachée par `defineContactForm`) est tolérée puis
 **abandonnée** : le schéma est dérivé à nouveau côté runtime par la même
 * fonction pure.
 */
const contactFormDeclarationSchema = z.object({
  key: z.string().min(1).max(CONTACT_KEY_MAX_LENGTH).regex(CONTACT_KEY_PATTERN),
  label: z.string().min(1).max(CONTACT_LABEL_MAX_LENGTH),
  description: z.string().min(1).max(CONTACT_DESCRIPTION_MAX_LENGTH).optional(),
  confirmationPath: z
    .string()
    .min(1)
    .max(512)
    .refine(isInternalConfirmationPath, 'chemin interne requis (commence par « / »)'),
  submitLabel: z.string().min(1).max(CONTACT_LABEL_MAX_LENGTH).optional(),
  honeypotField: z.string().min(1).max(60).regex(CONTACT_KEY_PATTERN).optional(),
  fields: z.unknown().transform((value, ctx) => {
    const parsed = parseContactFieldsRecord(value);
    if (parsed === null) {
      ctx.addIssue({ code: 'custom', message: 'champs non conformes au vocabulaire V1 des formulaires' });
      return z.NEVER;
    }
    return parsed;
  }),
  notification: z
    .object({
      recipients: z
        .array(z.string().refine(isSafeEmailAddress, 'adresse email invalide'))
        .min(1)
        .max(CONTACT_RECIPIENTS_MAX),
      subject: z
        .string()
        .min(1)
        .max(CONTACT_NOTIFICATION_SUBJECT_MAX_LENGTH)
        .refine(isSafeHeaderValue, 'sujet invalide (aucun caractère de contrôle)'),
      replyToField: z.string().min(1).max(60).optional(),
    })
    .optional(),
  // Propriété du Project (`defineContactForm` attache le schéma dérivé) —
  // non sérialisée, dérivée à nouveau côté runtime. Slot explicite.
  payloadSchema: z.unknown().optional(),
});

export const kreizConfigSchema = z.strictObject({
  content: z
    .strictObject({
      /** Types de contenu déclarés par le Project (ordre = ordre de navigation). */
      types: z.array(contentTypeDeclarationSchema).max(100),
    })
    .optional(),
  /** Formulaires de contact déclarés par le Project (slice 7). */
  forms: z.array(contactFormDeclarationSchema).max(20).optional(),
});

/**
 * Configuration normalisée — forme sérialisée vers `virtual:kreiz/config`.
 * `dataSchema` et `payloadSchema` sont retirés (dérivés côté runtime).
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
  forms?: Array<{
    key: string;
    label: string;
    description?: string;
    confirmationPath: string;
    submitLabel?: string;
    honeypotField?: string;
    fields: Record<string, ContactFieldDescriptor>;
    notification?: {
      recipients: readonly string[];
      subject: string;
      replyToField?: string;
    };
  }>;
};

export function normalizeKreizConfig(input: unknown): KreizConfig {
  const parsed = kreizConfigSchema.parse(input ?? {}) as {
    content?: { types: Array<Record<string, unknown>> };
    forms?: Array<Record<string, unknown>>;
  };
  const result: KreizConfig = {};
  if (parsed.content) {
    result.content = {
      types: parsed.content.types.map((type) => ({
        key: type.key as string,
        label: type.label as string,
        labelPlural: type.labelPlural as string | undefined,
        routeNamespace: type.routeNamespace as string,
        fields: type.fields as Record<string, FieldDescriptor>,
        template: type.template as string,
      })),
    };
  }
  if (parsed.forms) {
    result.forms = parsed.forms.map((form) => ({
      key: form.key as string,
      label: form.label as string,
      ...(form.description !== undefined ? { description: form.description as string } : {}),
      confirmationPath: form.confirmationPath as string,
      ...(form.submitLabel !== undefined ? { submitLabel: form.submitLabel as string } : {}),
      ...(form.honeypotField !== undefined ? { honeypotField: form.honeypotField as string } : {}),
      fields: form.fields as Record<string, ContactFieldDescriptor>,
      ...(form.notification !== undefined
        ? {
            notification: {
              recipients: (form.notification as { recipients: string[] }).recipients,
              subject: (form.notification as { subject: string }).subject,
              ...( (form.notification as { replyToField?: string }).replyToField !== undefined
                ? { replyToField: (form.notification as { replyToField?: string }).replyToField }
                : {}),
            },
          }
        : {}),
    }));
  }
  return result;
}
