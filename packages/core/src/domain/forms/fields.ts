import { z } from 'zod';
import {
  CONTACT_FIELD_MAX_COUNT,
  CONTACT_FIELD_NAME_MAX_LENGTH,
  CONTACT_FIELD_NAME_PATTERN,
  isSafeEmailAddress,
} from './policy.js';

/**
 * Vocabulaire de champs des formulaires publics (cadrage §13) — **borné**,
 * à l'image du vocabulaire des types de contenu. Un descripteur est une
 * donnée pure et sérialisable : le Core en dérive à la fois le rendu HTML
 * public (progressif, sans JavaScript) et le schéma Zod de validation
 * serveur — la validation Project et la validation serveur ne peuvent pas
 * diverger.
 *
 * V1 — volontairement restreint à ce qu'exige un contact :
 * - `text` : ligne simple ;
 * - `textarea` : message ;
 * - `email` : adresse validée (et seule candidate au `Reply-To`) ;
 * - `select` : liste fermée déclarée en code ;
 * - `consent` : case à cocher (consentement RGPD ; `required` = coche obligatoire).
 *
 * Aucun upload, aucun champ libre markup, aucune imbrication : la surface
 * d'attaque reste celle d'un formulaire de contact.
 */

// ——— Descripteurs ———

interface ContactFieldCommon {
  /** Libellé affiché (rendu échappé par le renderer). */
  readonly label: string;
  /** Aide courte rendue sous le champ. */
  readonly help?: string;
  readonly required?: boolean;
  /** Attribut autocomplete HTML (ex. `email`, `name`) — confort, jamais une validation. */
  readonly autocomplete?: string;
}

export interface ContactTextFieldDescriptor extends ContactFieldCommon {
  readonly kind: 'text';
  /** Longueur maximale (défaut 200). */
  readonly maxLength?: number;
  readonly placeholder?: string;
}

export interface ContactTextareaFieldDescriptor extends ContactFieldCommon {
  readonly kind: 'textarea';
  /** Longueur maximale (défaut 5 000 — borne anti-abus). */
  readonly maxLength?: number;
  readonly placeholder?: string;
}

export interface ContactEmailFieldDescriptor extends ContactFieldCommon {
  readonly kind: 'email';
  /** Longueur maximale (défaut 254 — borne RFC). */
  readonly maxLength?: number;
  readonly placeholder?: string;
}

export interface ContactSelectChoice<C extends string = string> {
  readonly value: C;
  readonly label: string;
}

export interface ContactSelectFieldDescriptor<C extends string = string> extends ContactFieldCommon {
  readonly kind: 'select';
  /** Liste fermée déclarée en code. */
  readonly choices: ReadonlyArray<ContactSelectChoice<C>>;
}

export interface ContactConsentFieldDescriptor extends ContactFieldCommon {
  readonly kind: 'consent';
  /** Texte de la case (ex. mention de confidentialité). */
  readonly checkboxLabel: string;
}

export type ContactFieldDescriptor =
  | ContactTextFieldDescriptor
  | ContactTextareaFieldDescriptor
  | ContactEmailFieldDescriptor
  | ContactSelectFieldDescriptor
  | ContactConsentFieldDescriptor;

// ——— Builders (API publique `formFields.*`) ———

/**
 * Helpers de déclaration — `formFields.text(…)`, `formFields.select(…)`…
 * Le `kind` est posé par le builder (même convention que le moteur de
 * contenu) : les déclarations du Project ne portent que du sens.
 */
export const formFields = {
  text(options: Omit<ContactTextFieldDescriptor, 'kind'>): ContactTextFieldDescriptor {
    return { kind: 'text', ...options };
  },
  textarea(options: Omit<ContactTextareaFieldDescriptor, 'kind'>): ContactTextareaFieldDescriptor {
    return { kind: 'textarea', ...options };
  },
  email(options: Omit<ContactEmailFieldDescriptor, 'kind'>): ContactEmailFieldDescriptor {
    return { kind: 'email', ...options };
  },
  select<C extends string>(options: Omit<ContactSelectFieldDescriptor<C>, 'kind'>): ContactSelectFieldDescriptor<C> {
    return { kind: 'select', ...options };
  },
  consent(options: Omit<ContactConsentFieldDescriptor, 'kind'>): ContactConsentFieldDescriptor {
    return { kind: 'consent', ...options };
  },
} as const;

// ——— Bornes par nature de champ ———

export const CONTACT_FIELD_DEFAULTS = {
  textMaxLength: 200,
  textareaMaxLength: 5000,
  emailMaxLength: 254,
  labelMaxLength: 200,
  helpMaxLength: 300,
  placeholderMaxLength: 120,
  selectChoiceCount: 30,
  selectChoiceValueMaxLength: 100,
  selectChoiceLabelMaxLength: 120,
  checkboxLabelMaxLength: 500,
} as const;

export function contactFieldMaxLength(descriptor: ContactFieldDescriptor): number {
  switch (descriptor.kind) {
    case 'text':
      return descriptor.maxLength ?? CONTACT_FIELD_DEFAULTS.textMaxLength;
    case 'textarea':
      return descriptor.maxLength ?? CONTACT_FIELD_DEFAULTS.textareaMaxLength;
    case 'email':
      return descriptor.maxLength ?? CONTACT_FIELD_DEFAULTS.emailMaxLength;
    case 'select':
      return CONTACT_FIELD_DEFAULTS.selectChoiceValueMaxLength;
    case 'consent':
      return 0;
  }
}

// ——— Validation de forme (definition-time, fail fast) ———

/** Retourne la liste des problèmes FR d'un descripteur de champ (vide = valide). */
export function validateContactFieldShape(name: string, descriptor: unknown): string[] {
  const problems: string[] = [];
  if (
    name.length < 1 ||
    name.length > CONTACT_FIELD_NAME_MAX_LENGTH ||
    !CONTACT_FIELD_NAME_PATTERN.test(name)
  ) {
    return [`nom de champ invalide « ${String(name)} » (attendu : minuscules/chiffres/underscore, commençant par une lettre)`];
  }
  if (typeof descriptor !== 'object' || descriptor === null) {
    return [`champ « ${name} » : descripteur invalide`];
  }
  const d = descriptor as Record<string, unknown>;
  const label = d.label;
  if (typeof label !== 'string' || label.length < 1 || label.length > CONTACT_FIELD_DEFAULTS.labelMaxLength) {
    problems.push(`champ « ${name} » : label requis (1–${CONTACT_FIELD_DEFAULTS.labelMaxLength} caractères)`);
  }
  if (d.help !== undefined && (typeof d.help !== 'string' || d.help.length > CONTACT_FIELD_DEFAULTS.helpMaxLength)) {
    problems.push(`champ « ${name} » : help invalide`);
  }
  if (
    d.autocomplete !== undefined &&
    (typeof d.autocomplete !== 'string' || d.autocomplete.length > 64 || !/^[\w-]+$/.test(d.autocomplete))
  ) {
    problems.push(`champ « ${name} » : autocomplete invalide (jeton simple attendu)`);
  }
  switch (d.kind) {
    case 'text':
    case 'textarea':
    case 'email': {
      if (d.maxLength !== undefined && (typeof d.maxLength !== 'number' || !Number.isInteger(d.maxLength) || d.maxLength < 1 || d.maxLength > 100_000)) {
        problems.push(`champ « ${name} » : maxLength invalide (1–100 000)`);
      }
      if (d.placeholder !== undefined && (typeof d.placeholder !== 'string' || d.placeholder.length > CONTACT_FIELD_DEFAULTS.placeholderMaxLength)) {
        problems.push(`champ « ${name} » : placeholder invalide`);
      }
      break;
    }
    case 'select': {
      const choices = d.choices;
      if (!Array.isArray(choices) || choices.length < 1 || choices.length > CONTACT_FIELD_DEFAULTS.selectChoiceCount) {
        problems.push(`champ « ${name} » : choices requis (1–${CONTACT_FIELD_DEFAULTS.selectChoiceCount} choix)`);
        break;
      }
      const values = new Set<string>();
      for (const choice of choices) {
        const value = (choice as { value?: unknown } | null)?.value;
        const choiceLabel = (choice as { label?: unknown } | null)?.label;
        if (typeof value !== 'string' || value.length < 1 || value.length > CONTACT_FIELD_DEFAULTS.selectChoiceValueMaxLength) {
          problems.push(`champ « ${name} » : valeur de choix invalide`);
        } else if (values.has(value)) {
          problems.push(`champ « ${name} » : valeur de choix dupliquée « ${value} »`);
        }
        values.add(typeof value === 'string' ? value : '');
        if (typeof choiceLabel !== 'string' || choiceLabel.length < 1 || choiceLabel.length > CONTACT_FIELD_DEFAULTS.selectChoiceLabelMaxLength) {
          problems.push(`champ « ${name} » : label de choix invalide`);
        }
      }
      break;
    }
    case 'consent': {
      const checkboxLabel = d.checkboxLabel;
      if (typeof checkboxLabel !== 'string' || checkboxLabel.length < 1 || checkboxLabel.length > CONTACT_FIELD_DEFAULTS.checkboxLabelMaxLength) {
        problems.push(`champ « ${name} » : checkboxLabel requis (1–${CONTACT_FIELD_DEFAULTS.checkboxLabelMaxLength} caractères)`);
      }
      break;
    }
    default:
      problems.push(`champ « ${name} » : kind inconnu (vocabulaire V1 : text, textarea, email, select, consent)`);
  }
  return problems;
}

/** Parse un enregistrement de champs déclaré — `null` si non conforme. */
export function parseContactFieldsRecord(value: unknown): Record<string, ContactFieldDescriptor> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > CONTACT_FIELD_MAX_COUNT) return null;
  const fields: Record<string, ContactFieldDescriptor> = {};
  for (const [name, descriptor] of entries) {
    if (validateContactFieldShape(name, descriptor).length > 0) return null;
    fields[name] = descriptor as ContactFieldDescriptor;
  }
  return fields;
}

// ——— Valeurs typées ———

/** Valeur validée d'un champ dans le payload stocké. */
export type ContactFieldValue = string | boolean;

export type ContactFieldsData<F extends Record<string, ContactFieldDescriptor>> = {
  [K in keyof F]: F[K] extends ContactSelectFieldDescriptor<infer C>
    ? C
    : F[K] extends ContactConsentFieldDescriptor
      ? true
      : F[K] extends ContactEmailFieldDescriptor | ContactTextFieldDescriptor | ContactTextareaFieldDescriptor
        ? string
        : never;
};

// ——— Schéma Zod dérivé (source unique : les descripteurs) ———

export type ContactFieldErrors = Record<string, string>;

/**
 * Message FR prêt à afficher pour une issue Zod du schéma dérivé — même
 * philosophie que `contentFieldErrorMessage` : mapping local borné, pas de
 * locale globale mutée.
 */
export function contactFieldErrorMessage(issue: {
  code: string;
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}): string {
  switch (issue.code) {
    case 'too_small':
      if (issue.minimum === 1 && issue.origin === 'string') return 'Ce champ est requis.';
      return `Doit contenir au moins ${String(issue.minimum)} caractères.`;
    case 'too_big':
      return `Trop long (${String(issue.maximum)} caractères maximum).`;
    case 'invalid_value':
      return 'Choix invalide.';
    default:
      // Les issues `custom` du schéma portent déjà un message FR prêt à
      // afficher (requis, email, choix, consentement) — on le restitue tel quel.
      return issue.message;
  }
}

/**
 * Schéma strict du payload, dérivé des champs déclarés :
 * - whitelist totale — les champs non déclarés ne sont jamais lus ;
 * - chaque valeur est trimmée puis bornée (`required` = non vide) ;
 * - email : validation stricte sûre en en-tête (`isSafeEmailAddress`) ;
 * - select : valeur obligatoirement dans la liste fermée ;
 * - consent : boolean (`true` uniquement stocké) ;
 * - un champ optionnel laissé vide est **omis** du payload (pas de chaîne
 *   vide en base — même convention que le moteur de contenu).
 */
export function contactPayloadSchemaFromFields(
  fields: Record<string, ContactFieldDescriptor>,
): z.ZodType<Record<string, ContactFieldValue>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, descriptor] of Object.entries(fields)) {
    // Un champ **absent** du POST (checkbox décochée absente du corps, champ
    // non envoyé) est traité comme vide — pas comme une erreur de type : les
    // messages restent « Ce champ est requis. » / omission.
    const empty = descriptor.kind === 'consent' ? false : '';
    const wrap = (schema: z.ZodTypeAny): z.ZodTypeAny => z.preprocess((value) => value ?? empty, schema);
    switch (descriptor.kind) {
      case 'text':
      case 'textarea': {
        const max = contactFieldMaxLength(descriptor);
        shape[name] = wrap(
          descriptor.required
            ? z.string().trim().min(1).max(max)
            : z.string().trim().max(max).transform((value) => (value.length === 0 ? undefined : value)),
        );
        break;
      }
      case 'email': {
        const max = contactFieldMaxLength(descriptor);
        shape[name] = wrap(
          z
            .string()
            .trim()
            .max(max)
            .superRefine((value, ctx) => {
              if (value.length === 0) {
                if (descriptor.required) {
                  ctx.addIssue({ code: 'custom', message: 'Ce champ est requis.' });
                }
                return;
              }
              if (!isSafeEmailAddress(value)) {
                ctx.addIssue({ code: 'custom', message: 'Adresse email invalide.' });
              }
            })
            .transform((value) => (!descriptor.required && value.length === 0 ? undefined : value)),
        );
        break;
      }
      case 'select': {
        const values = descriptor.choices.map((choice) => choice.value) as [string, ...string[]];
        // Vide → omis (optionnel) ou « requis » ; non vide → nécessairement
        // dans la liste fermée.
        shape[name] = wrap(
          z
            .string()
            .trim()
            .superRefine((value, ctx) => {
              if (value.length === 0) {
                if (descriptor.required) {
                  ctx.addIssue({ code: 'custom', message: 'Ce champ est requis.' });
                }
                return;
              }
              if (!values.includes(value)) {
                ctx.addIssue({ code: 'custom', message: 'Choix invalide.' });
              }
            })
            .transform((value) => (!descriptor.required && value.length === 0 ? undefined : value)),
        );
        break;
      }
      case 'consent': {
        shape[name] = wrap(
          descriptor.required
            ? z.boolean().refine((value) => value === true, { message: 'Vous devez cocher cette case.' })
            : z.boolean().transform((value) => (value ? true : undefined)),
        );
        break;
      }
    }
  }
  return z.strictObject(shape).transform((parsed) => {
    const payload: Record<string, ContactFieldValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) payload[key] = value as ContactFieldValue;
    }
    return payload;
  });
}

/** Applique le schéma et retourne soit le payload, soit les erreurs par champ. */
export function validateContactPayload(
  fields: Record<string, ContactFieldDescriptor>,
  input: Record<string, unknown>,
): { ok: true; payload: Record<string, ContactFieldValue> } | { ok: false; fieldErrors: ContactFieldErrors } {
  const result = contactPayloadSchemaFromFields(fields).safeParse(input);
  if (result.success) {
    return { ok: true, payload: result.data };
  }
  const fieldErrors: ContactFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    const key = typeof field === 'string' ? field : '_form';
    fieldErrors[key] ??= contactFieldErrorMessage(issue);
  }
  return { ok: false, fieldErrors };
}
