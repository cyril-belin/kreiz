import type { z } from 'zod';
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
} from './policy.js';
import {
  type ContactFieldDescriptor,
  type ContactFieldsData,
  type ContactFieldValue,
  parseContactFieldsRecord,
} from './fields.js';
import { contactPayloadSchemaFromFields } from './fields.js';

/**
 * Déclaration d'un formulaire de contact — **écrite en code par le Project**
 * (cadrage §13), jamais configurable depuis l'UI : l'admin consulte les
 * demandes, il n'édite pas les formulaires.
 *
 * ```ts
 * export const contactForm = defineContactForm({
 *   key: 'contact',                    // form_id en base, /api/forms/contact
 *   label: 'Contact',
 *   fields: {
 *     name: formFields.text({ label: 'Nom', required: true, autocomplete: 'name' }),
 *     email: formFields.email({ label: 'Email', required: true, autocomplete: 'email' }),
 *     message: formFields.textarea({ label: 'Message', required: true, maxLength: 2000 }),
 *   },
 *   confirmationPath: '/contact/merci',
 *   notification: {
 *     recipients: ['contact@example.com'],   // destinataires — code uniquement
 *     subject: 'Nouveau message',
 *   },
 * });
 * ```
 *
 * **Anti open-relay structurel** : les destinataires (`to`), l'expéditeur
 * affiché (`from`, env) et le sujet sont des données **de code ou d'env
 * serveur** — aucune entrée visiteur ne devient jamais une adresse
 * d'enveloppe. La seule valeur visiteur dans l'enveloppe est le `Reply-To`,
 * validé par un email sûr (pas de CR/LF/caractères de contrôle) et uniquement
 * quand il correspond à un champ `email` déclaré.
 */

export interface ContactFormNotificationOptions {
  /** Destinataires de la notification (1–5 adresses validées à la déclaration). */
  readonly recipients: ReadonlyArray<string>;
  /** Sujet du mail (1–200 caractères, aucun caractère de contrôle — validé). */
  readonly subject: string;
  /**
   * Champ `email` dont la valeur devient le `Reply-To`. Défaut : l'unique
   * champ email du formulaire s'il existe exactement un champ de ce type.
   */
  readonly replyToField?: string;
}

export interface ContactFormDeclaration<F extends Record<string, ContactFieldDescriptor> = Record<string, ContactFieldDescriptor>> {
  /** Clé stable — `form_id` en base, segment public `/api/forms/<key>`. */
  readonly key: string;
  /** Titre dans l'admin et le rendu. */
  readonly label: string;
  /** Description optionnelle (admin + rendu). */
  readonly description?: string;
  /** Champs — vocabulaire borné (`formFields.*`). */
  readonly fields: F;
  /**
   * Page de remerciement **interne au site** (chemin relatif commençant par
   * `/`) — destination de la redirection 303 après soumission (PRG).
   */
  readonly confirmationPath: string;
  /** Libellé du bouton (défaut : « Envoyer »). */
  readonly submitLabel?: string;
  /** Configuration de la notification email — optionnelle : sans elle, la demande reste visible dans l'admin. */
  readonly notification?: ContactFormNotificationOptions;
  /**
   * Nom du champ honeypot — l'input leurre doit rester anodin. Défaut :
   * `website` (le classique « remplissez votre site web » des bots).
   */
  readonly honeypotField?: string;
}

/** Déclaration définie : plus le schéma dérivé, pour le typage du Project. */
export interface ContactFormDefinition<F extends Record<string, ContactFieldDescriptor> = Record<string, ContactFieldDescriptor>>
  extends ContactFormDeclaration<F> {
  /** Schéma strict dérivé des champs — source unique Project/Core. */
  readonly payloadSchema: z.ZodType<Record<string, ContactFieldValue>>;
}

/** Typage du payload : `type ContactData = InferContactFormData<typeof contactForm>`. */
export type InferContactFormData<D extends ContactFormDefinition> = ContactFieldsData<D['fields']>;

export const DEFAULT_HONEYPOT_FIELD = 'website';
export const DEFAULT_SUBMIT_LABEL = 'Envoyer';

/**
 * Déclare un formulaire de contact. Valide la forme **à la définition**
 * (fail fast au chargement de la config, pas à la première soumission) :
 * clé, champs, chemin de confirmation, destinataires, sujet.
 */
export function defineContactForm<F extends Record<string, ContactFieldDescriptor>>(
  definition: ContactFormDeclaration<F>,
): ContactFormDefinition<F> {
  validateContactFormShape(definition);
  return {
    key: definition.key,
    label: definition.label,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    fields: definition.fields,
    confirmationPath: definition.confirmationPath,
    ...(definition.submitLabel !== undefined ? { submitLabel: definition.submitLabel } : {}),
    ...(definition.notification !== undefined ? { notification: definition.notification } : {}),
    ...(definition.honeypotField !== undefined ? { honeypotField: definition.honeypotField } : {}),
    payloadSchema: contactPayloadSchemaFromFields(definition.fields),
  };
}

/** Résout le nom du champ honeypot (défaut : `website`). */
export function contactHoneypotField(definition: Pick<ContactFormDeclaration, 'honeypotField'>): string {
  return definition.honeypotField ?? DEFAULT_HONEYPOT_FIELD;
}

/**
 * Résout le nom du champ `email` portant le `Reply-To` : champ explicite
 * (`notification.replyToField`) ou l'unique champ email déclaré. Retourne
 * `null` quand rien ne permet de désigner un Reply-To de façon non
 * ambiguë — on n'en met pas, plutôt qu'un mauvais.
 */
export function contactReplyToFieldName(
  definition: Pick<ContactFormDeclaration, 'fields' | 'notification'>,
): string | null {
  const explicit = definition.notification?.replyToField;
  const emailFields = Object.entries(definition.fields)
    .filter(([, descriptor]) => descriptor.kind === 'email')
    .map(([name]) => name);
  if (explicit !== undefined) {
    const descriptor = definition.fields[explicit];
    return descriptor && descriptor.kind === 'email' ? explicit : null;
  }
  return emailFields.length === 1 ? emailFields[0]! : null;
}

/** Valide la forme d'une déclaration — lève avec la liste des problèmes FR. */
export function validateContactFormShape(
  definition: Pick<
    ContactFormDeclaration,
    'key' | 'label' | 'description' | 'fields' | 'confirmationPath' | 'submitLabel' | 'notification' | 'honeypotField'
  >,
): void {
  const problems: string[] = [];
  if (
    definition.key.length < 1 ||
    definition.key.length > CONTACT_KEY_MAX_LENGTH ||
    !CONTACT_KEY_PATTERN.test(definition.key)
  ) {
    problems.push(
      `clé invalide « ${String(definition.key)} » (attendu : minuscules/chiffres/underscore, commençant par une lettre)`,
    );
  }
  if (definition.label.length < 1 || definition.label.length > CONTACT_LABEL_MAX_LENGTH) {
    problems.push(`label requis (1–${CONTACT_LABEL_MAX_LENGTH} caractères)`);
  }
  if (
    definition.description !== undefined &&
    (definition.description.length < 1 || definition.description.length > CONTACT_DESCRIPTION_MAX_LENGTH)
  ) {
    problems.push(`description invalide (1–${CONTACT_DESCRIPTION_MAX_LENGTH} caractères)`);
  }
  if (!isInternalConfirmationPath(definition.confirmationPath)) {
    problems.push(
      'confirmationPath invalide — chemin interne requis (commence par « / », jamais une URL absolue ni protocol-relative)',
    );
  }
  if (
    definition.submitLabel !== undefined &&
    (definition.submitLabel.length < 1 || definition.submitLabel.length > CONTACT_LABEL_MAX_LENGTH || !isSafeHeaderValue(definition.submitLabel))
  ) {
    problems.push('submitLabel invalide');
  }
  if (
    definition.honeypotField !== undefined &&
    (definition.honeypotField.length < 1 ||
      definition.honeypotField.length > 60 ||
      !CONTACT_KEY_PATTERN.test(definition.honeypotField))
  ) {
    problems.push('honeypotField invalide (jeton simple)');
  }
  const fields = parseContactFieldsRecord(definition.fields);
  if (fields === null) {
    problems.push('champs non conformes au vocabulaire V1 (kind inconnu, options invalides, trop de champs…)');
  } else if (definition.honeypotField !== undefined && definition.honeypotField in fields) {
    problems.push('honeypotField ne doit pas être un champ déclaré');
  }
  if (definition.notification !== undefined) {
    const notification = definition.notification;
    const recipients = notification.recipients;
    if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > CONTACT_RECIPIENTS_MAX) {
      problems.push(`notification.recipients requis (1–${CONTACT_RECIPIENTS_MAX} adresses)`);
    } else {
      const unique = new Set(recipients);
      if (unique.size !== recipients.length) problems.push('notification.recipients : doublon');
      for (const recipient of recipients) {
        if (typeof recipient !== 'string' || !isSafeEmailAddress(recipient)) {
          problems.push(`notification.recipients : adresse invalide « ${String(recipient).slice(0, 60)} »`);
        }
      }
    }
    if (
      typeof notification.subject !== 'string' ||
      notification.subject.length < 1 ||
      notification.subject.length > CONTACT_NOTIFICATION_SUBJECT_MAX_LENGTH ||
      !isSafeHeaderValue(notification.subject)
    ) {
      problems.push(
        `notification.subject requis (1–${CONTACT_NOTIFICATION_SUBJECT_MAX_LENGTH} caractères, aucun caractère de contrôle — anti-injection d'en-têtes)`,
      );
    }
    if (fields === null && notification.replyToField !== undefined) {
      problems.push('notification.replyToField : vérifiable seulement avec des champs valides');
    } else if (fields !== null && notification.replyToField !== undefined) {
      const descriptor = fields[notification.replyToField];
      if (!descriptor || descriptor.kind !== 'email') {
        problems.push('notification.replyToField doit référencer un champ email déclaré');
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `@kreiz/core : déclaration de formulaire invalide (« ${definition.key} ») — ${problems.join(' ; ')}.`,
    );
  }
}
