/**
 * API publique des formulaires — sous-chemin `@kreiz/core/forms` (cadrage
 * §13). C'est ici que le Project déclare ses formulaires de contact et
 * rend le HTML public (progressif, sans JavaScript obligatoire). Le
 * rendu/rendu des erreurs, l'endpoint de soumission et la boîte admin
 * appartiennent au Core — le Project ne fournit que la déclaration, la
 * page qui l'affiche et la page de remerciement.
 */

// Déclaration de formulaires
export { defineContactForm, contactReplyToFieldName, contactHoneypotField } from '../domain/forms/declaration.js';
export type {
  ContactFormDefinition,
  ContactFormDeclaration,
  ContactFormNotificationOptions,
  InferContactFormData,
} from '../domain/forms/declaration.js';

// Vocabulaire de champs
export { formFields } from '../domain/forms/fields.js';
export type {
  ContactFieldDescriptor,
  ContactTextFieldDescriptor,
  ContactTextareaFieldDescriptor,
  ContactEmailFieldDescriptor,
  ContactSelectFieldDescriptor,
  ContactSelectChoice,
  ContactConsentFieldDescriptor,
  ContactFieldValue,
  ContactFieldsData,
} from '../domain/forms/fields.js';

// Politique (bornes et validators purs — utiles au Project pour tester ses déclarations)
export {
  CONTACT_KEY_PATTERN,
  CONTACT_FIELD_NAME_PATTERN,
  isSafeEmailAddress,
  isInternalConfirmationPath,
} from '../domain/forms/policy.js';

// Rendu HTML public (page statique du Project, `set:html`)
export { renderContactFormHtml } from '../domain/forms/render.js';
export type { ContactFormRenderValues } from '../domain/forms/render.js';

// Jeton d'émission (rendu) + chemin de l'endpoint de soumission
export { issueFormToken, type IssuedFormToken } from '../domain/forms/token.js';
export { publicFormSubmitPath, FORM_TOKEN_FIELD } from '../domain/forms/policy.js';
