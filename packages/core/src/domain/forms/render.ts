import {
  type ContactFieldDescriptor,
  type ContactFieldErrors,
  contactFieldMaxLength,
} from './fields.js';
import type { ContactFormDeclaration } from './declaration.js';
import { contactHoneypotField } from './declaration.js';
import { publicFormSubmitPath, FORM_TOKEN_FIELD } from './policy.js';
import type { FormToken } from './token.js';

/**
 * Rendu HTML public d'un formulaire de contact — fonction pure, déterministe,
 * **progressive** : le formulaire fonctionne sans une ligne de JavaScript
 * (POST multipart/urlencoded classique, re-rendu serveur des erreurs) et
 * reste améliorable par le Project s'il le souhaite.
 *
 * Tout le texte interpolé (labels, aides, valeurs soumises) est échappé —
 * la seule sortie HTML est celle du renderer, jamais celle du visiteur.
 * Les classes `kz-*` sont des points d'ancrage de style **pour le Project**
 * (le rendu reste lisible sans CSS) : le Core ne livre aucune feuille de
 * style publique — la présentation appartient au projet (principe §1).
 */

export interface ContactFormRenderValues {
  /** Valeurs brutes soumises à re-rendre (après erreur de validation). */
  values: Record<string, string | boolean>;
  /** Erreurs par champ (message FR prêt à afficher). */
  fieldErrors: ContactFieldErrors;
  /** Erreur générale (hors champ — honeypot absent d'ici, jeton re-signé ailleurs). */
  formError: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Rendu HTML complet du `<form>` — voir la doc du module. */
export function renderContactFormHtml(options: {
  form: Pick<ContactFormDeclaration, 'key' | 'label' | 'description' | 'fields' | 'submitLabel' | 'honeypotField'>;
  token: FormToken;
  values?: Partial<ContactFormRenderValues>;
}): string {
  const { form, token } = options;
  const values = options.values ?? {};
  const submitted = values.values ?? {};
  const fieldErrors = values.fieldErrors ?? {};
  const honeypot = contactHoneypotField(form);
  const domId = (name: string): string => `kz-form-${form.key}-${name}`;

  const parts: string[] = [];
  const descriptionAttribute = form.description
    ? ` aria-describedby="${domId('__description__')}"`
    : '';
  parts.push(
    `<form method="post" action="${escapeHtml(publicFormSubmitPath(form.key))}" class="kz-form"${descriptionAttribute}>`,
  );
  // Jeton d'émission signé — preuve de possession d'une vraie page ; l'instant
  // d'émission qu'il porte sert au temps minimal de remplissage.
  parts.push(`<input type="hidden" name="${FORM_TOKEN_FIELD}" value="${escapeHtml(token)}">`);

  parts.push('<div class="kz-form__body">');
  if (form.description) {
    parts.push(
      `<p class="kz-form__description" id="${domId('__description__')}">${escapeHtml(form.description)}</p>`,
    );
  }
  if (values.formError) {
    parts.push(
      `<p class="kz-form__error kz-form__error--form" role="alert">${escapeHtml(values.formError)}</p>`,
    );
  }

  for (const [name, descriptor] of Object.entries(form.fields)) {
    parts.push(renderField({ formKey: form.key, name, descriptor, submitted, error: fieldErrors[name] ?? null, domId }));
  }

  // Honeypot — champ leurre : masqué (`hidden`), hors tabulation, jamais
  // annoncé aux lecteurs d'écran ; rempli = soumission d'un bot (rejet
  // silencieux côté service).
  parts.push(
    `<div hidden aria-hidden="true"><label for="${domId(honeypot)}">Ne pas remplir ce champ</label>` +
      `<input type="text" id="${domId(honeypot)}" name="${escapeHtml(honeypot)}" tabindex="-1" autocomplete="off"></div>`,
  );

  parts.push('</div>');
  parts.push(
    `<div class="kz-form__actions"><button type="submit" class="kz-form__submit">${escapeHtml(form.submitLabel ?? 'Envoyer')}</button></div>`,
  );
  parts.push('</form>');
  return parts.join('\n');
}

function renderField(options: {
  formKey: string;
  name: string;
  descriptor: ContactFieldDescriptor;
  submitted: Record<string, string | boolean>;
  error: string | null;
  domId: (name: string) => string;
}): string {
  const { name, descriptor, submitted, error, domId } = options;
  const id = domId(name);
  const describedBy = error ? ` aria-describedby="${id}-error" aria-invalid="true"` : '';
  const errorHtml = error
    ? `<p class="kz-form__error" id="${id}-error" role="alert">${escapeHtml(error)}</p>`
    : '';
  const labelHtml = `<label class="kz-form__label" for="${id}">${escapeHtml(descriptor.label)}${descriptor.required ? ' <span class="kz-form__required" title="Champ requis">*</span>' : ''}</label>`;
  const helpHtml = descriptor.help
    ? `<p class="kz-form__help" id="${id}-help">${escapeHtml(descriptor.help)}</p>`
    : '';
  const helpDescribedBy = descriptor.help ? ` aria-describedby="${id}-help"` : '';

  const wrapper = (inner: string): string =>
    `<div class="kz-form__field kz-form__field--${escapeHtml(descriptor.kind)}${error ? ' kz-form__field--invalid' : ''}">${labelHtml}${helpHtml}${inner}${errorHtml}</div>`;

  const rawValue = submitted[name];

  switch (descriptor.kind) {
    case 'text':
    case 'email': {
      const type = descriptor.kind === 'email' ? 'email' : 'text';
      const value = typeof rawValue === 'string' ? rawValue : '';
      const autocomplete = descriptor.autocomplete ? ` autocomplete="${escapeHtml(descriptor.autocomplete)}"` : '';
      const placeholder = descriptor.placeholder ? ` placeholder="${escapeHtml(descriptor.placeholder)}"` : '';
      return wrapper(
        `<input class="kz-form__input" type="${type}" id="${id}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" maxlength="${contactFieldMaxLength(descriptor)}"${autocomplete}${placeholder}${describedBy || helpDescribedBy}>`,
      );
    }
    case 'textarea': {
      const value = typeof rawValue === 'string' ? rawValue : '';
      const placeholder = descriptor.placeholder ? ` placeholder="${escapeHtml(descriptor.placeholder)}"` : '';
      return wrapper(
        `<textarea class="kz-form__input kz-form__input--textarea" id="${id}" name="${escapeHtml(name)}" maxlength="${contactFieldMaxLength(descriptor)}" rows="6"${placeholder}${describedBy || helpDescribedBy}>${escapeHtml(value)}</textarea>`,
      );
    }
    case 'select': {
      const value = typeof rawValue === 'string' ? rawValue : '';
      const optionsHtml = descriptor.choices
        .map((choice) => {
          const selected = choice.value === value ? ' selected' : '';
          return `<option value="${escapeHtml(choice.value)}"${selected}>${escapeHtml(choice.label)}</option>`;
        })
        .join('');
      const emptyOption = descriptor.required
        ? '<option value="">—</option>'
        : '<option value=""></option>';
      return wrapper(
        `<select class="kz-form__input" id="${id}" name="${escapeHtml(name)}"${describedBy || helpDescribedBy}>${emptyOption}${optionsHtml}</select>`,
      );
    }
    case 'consent': {
      const checked = rawValue === true ? ' checked' : '';
      return `<div class="kz-form__field kz-form__field--consent${error ? ' kz-form__field--invalid' : ''}">` +
        `<input class="kz-form__checkbox" type="checkbox" id="${id}" name="${escapeHtml(name)}" value="true"${checked}${describedBy || helpDescribedBy}>` +
        `<label class="kz-form__label kz-form__label--consent" for="${id}">${escapeHtml(descriptor.checkboxLabel)}${descriptor.required ? ' <span class="kz-form__required" title="Champ requis">*</span>' : ''}</label>` +
        `${helpHtml}${errorHtml}</div>`;
    }
  }
}
