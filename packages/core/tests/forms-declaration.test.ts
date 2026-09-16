import { describe, expect, it } from 'vitest';
import { type ContactFormDeclaration, defineContactForm, contactHoneypotField, contactReplyToFieldName } from '../src/domain/forms/declaration';
import { createContactFormRegistry, resolveContactFormDefinition } from '../src/domain/forms/registry';
import {
  contactFieldMaxLength,
  formFields,
  validateContactPayload,
} from '../src/domain/forms/fields';
import {
  CONTACT_FIELD_MAX_COUNT,
  isInternalConfirmationPath,
  isSafeEmailAddress,
  isSafeHeaderValue,
} from '../src/domain/forms/policy';

/**
 * Déclaration des formulaires de contact (cadrage §13) — fail fast à la
 * définition : clé, champs, chemin de confirmation, anti open-relay
 * (destinataires/sujet validés), honeypot. Le schéma de payload est dérivé
 * des champs — la validation Project et serveur ne peuvent pas diverger.
 */

const baseFields = {
  name: formFields.text({ label: 'Nom', required: true }),
  email: formFields.email({ label: 'Email', required: true }),
  message: formFields.textarea({ label: 'Message', required: true, maxLength: 500 }),
};

function validDeclaration() {
  return {
    key: 'contact',
    label: 'Contact',
    fields: baseFields,
    confirmationPath: '/contact/merci',
    notification: {
      recipients: ['bonjour@example.test'],
      subject: 'Nouveau message',
    },
  };
}

describe('defineContactForm — déclaration valide', () => {
  it('accepte une déclaration complète et dérive le schéma', () => {
    const form = defineContactForm(validDeclaration());
    expect(form.key).toBe('contact');
    expect(form.payloadSchema).toBeDefined();
    // Le schéma dérivé valide le payload complet.
    const parsed = validateContactPayload(form.fields, {
      name: 'Alice',
      email: 'alice@example.test',
      message: 'Bonjour',
    });
    expect(parsed.ok).toBe(true);
  });

  it('honeypot par défaut = website, personnalisable', () => {
    expect(contactHoneypotField({ honeypotField: undefined })).toBe('website');
    expect(contactHoneypotField({ honeypotField: 'company' })).toBe('company');
  });

  it('replyTo = champ explicite, ou unique champ email, sinon null', () => {
    expect(contactReplyToFieldName(validDeclaration())).toBe('email');
    // Deux champs email sans replyToField explicite → ambigu → null.
    const ambiguous = defineContactForm({
      ...validDeclaration(),
      fields: {
        ...baseFields,
        second_email: formFields.email({ label: 'Email pro' }),
      },
    });
    expect(contactReplyToFieldName(ambiguous)).toBeNull();
    // Explicite invalide (pas un champ email) → rejeté à la définition
    // (fail fast) ; et la résolution ne retournerait jamais une adresse au
    // hasard.
    expect(
      () =>
        defineContactForm({
          key: 'reply_bad',
          label: 'x',
          fields: baseFields,
          confirmationPath: '/merci',
          notification: { recipients: ['a@b.test'], subject: 's', replyToField: 'name' },
        }),
    ).toThrow(/replyToField/);
    // Explicite valide.
    const good = defineContactForm({
      key: 'reply_good',
      label: 'x',
      fields: { ...baseFields, second_email: formFields.email({ label: 'Email pro' }) },
      confirmationPath: '/merci',
      notification: { recipients: ['a@b.test'], subject: 's', replyToField: 'second_email' },
    });
    expect(contactReplyToFieldName(good)).toBe('second_email');
  });
});

describe('defineContactForm — rejets à la définition (fail fast)', () => {
  it('clé invalide', () => {
    expect(() =>
      defineContactForm({ ...validDeclaration(), key: 'Bad-Key' }),
    ).toThrow(/clé invalide/);
  });

  it('confirmationPath externe ou protocol-relative refusé (anti open-redirect)', () => {
    expect(() =>
      defineContactForm({ ...validDeclaration(), confirmationPath: 'https://evil.example/merci' }),
    ).toThrow(/confirmationPath/);
    expect(() =>
      defineContactForm({ ...validDeclaration(), confirmationPath: '//evil.example' }),
    ).toThrow(/confirmationPath/);
    expect(() =>
      defineContactForm({ ...validDeclaration(), confirmationPath: '/merci?x=\n' }),
    ).toThrow(/confirmationPath/);
  });

  it('destinataires invalides refusés (anti open-relay structurel)', () => {
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: { recipients: [], subject: 's' },
      }),
    ).toThrow(/recipients/);
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: { recipients: ['pas-une-adresse'], subject: 's' },
      }),
    ).toThrow(/adresse invalide/);
    // Injection d'en-tête via un destinataire : impossible.
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: { recipients: ['a@b.test\r\nBcc: victim@example.test'], subject: 's' },
      }),
    ).toThrow(/adresse invalide/);
    // Trop de destinataires.
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: {
          recipients: Array.from({ length: 6 }, (_, i) => `a${i}@b.test`),
          subject: 's',
        },
      }),
    ).toThrow(/recipients/);
    // Doublon.
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: { recipients: ['a@b.test', 'a@b.test'], subject: 's' },
      }),
    ).toThrow(/doublon/);
  });

  it('sujet avec caractère de contrôle refusé (anti-injection)', () => {
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        notification: { recipients: ['a@b.test'], subject: 'Sujet\r\nX-Inject: oui' },
      }),
    ).toThrow(/subject/);
  });

  it('replyToField doit référencer un champ email déclaré', () => {
    expect(() =>
      defineContactForm({
        key: 'reply_x',
        label: 'x',
        fields: baseFields,
        confirmationPath: '/merci',
        notification: { recipients: ['a@b.test'], subject: 's', replyToField: 'message' },
      }),
    ).toThrow(/replyToField/);
  });

  it('honeypotField doit être un jeton simple, distinct des champs', () => {
    expect(() =>
      defineContactForm({ ...validDeclaration(), honeypotField: 'email' }),
    ).toThrow(/honeypotField/);
    expect(() =>
      defineContactForm({ ...validDeclaration(), honeypotField: 'a b' }),
    ).toThrow(/honeypotField/);
  });

  it('trop de champs refusé (borne anti-abus)', () => {
    const fields: Record<string, ReturnType<typeof formFields.text>> = {};
    for (let index = 0; index <= CONTACT_FIELD_MAX_COUNT; index += 1) {
      fields[`f${index}`] = formFields.text({ label: `F${index}` });
    }
    expect(() => defineContactForm({ ...validDeclaration(), fields })).toThrow(/vocabulaire/);
  });

  it('kind inconnu refusé', () => {
    expect(() =>
      defineContactForm({
        ...validDeclaration(),
        fields: { bad: { kind: 'money', label: 'x' } as never },
      }),
    ).toThrow(/vocabulaire/);
  });
});

describe('schéma de payload dérivé', () => {
  const form = defineContactForm({
    ...validDeclaration(),
    fields: {
      name: formFields.text({ label: 'Nom', required: true, maxLength: 10 }),
      email: formFields.email({ label: 'Email', required: true }),
      topic: formFields.select({
        label: 'Sujet',
        choices: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
      consent: formFields.consent({ label: 'C', checkboxLabel: 'OK', required: true }),
      phone: formFields.text({ label: 'Téléphone' }),
    },
  });

  it('trim + omission des champs optionnels vides', () => {
    const parsed = validateContactPayload(form.fields, {
      name: '  Alice ',
      email: 'a@b.test',
      topic: '',
      consent: true,
      phone: '',
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload).toEqual({ name: 'Alice', email: 'a@b.test', consent: true });
    }
  });

  it('requis vide → erreur de champ dédiée', () => {
    const parsed = validateContactPayload(form.fields, { name: '', email: '', consent: false });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.fieldErrors.name).toMatch(/requis/i);
      expect(parsed.fieldErrors.email).toMatch(/requis/i);
      expect(parsed.fieldErrors.consent).toMatch(/cocher/i);
    }
  });

  it('bornes de longueur et select fermé', () => {
    const tooLong = validateContactPayload(form.fields, {
      name: 'x'.repeat(11),
      email: 'a@b.test',
      consent: true,
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.fieldErrors.name).toMatch(/Trop long/);

    const badChoice = validateContactPayload(form.fields, {
      name: 'ok',
      email: 'a@b.test',
      topic: 'inconnu',
      consent: true,
    });
    expect(badChoice.ok).toBe(false);
    if (!badChoice.ok) expect(badChoice.fieldErrors.topic).toMatch(/Choix/);
  });

  it('email dangereux (injection CRLF, espaces) refusé', () => {
    for (const hostile of [
      'a@b.test\r\nBcc: victim@x.test',
      'a b@c.test',
      'a@b',
      'a@b.test\t(x)',
      'a..b@c.test',
      '.a@c.test',
      'a@c..test',
    ]) {
      const parsed = validateContactPayload(form.fields, {
        name: 'ok',
        email: hostile,
        consent: true,
      });
      expect(parsed.ok, hostile).toBe(false);
      if (!parsed.ok) expect(parsed.fieldErrors.email).toMatch(/email invalide/i);
    }
  });

  it('champs non déclarés rejetés (strictObject — whitelist)', () => {
    const parsed = validateContactPayload(form.fields, {
      name: 'a',
      email: 'a@b.test',
      consent: true,
      recipients: ['victim@evil.test'],
    });
    expect(parsed.ok).toBe(false);
  });

  it('longueur effective par nature de champ (défauts)', () => {
    expect(contactFieldMaxLength(formFields.text({ label: 'x' }))).toBe(200);
    expect(contactFieldMaxLength(formFields.textarea({ label: 'x' }))).toBe(5000);
    expect(contactFieldMaxLength(formFields.email({ label: 'x' }))).toBe(254);
  });
});

describe('validators purs de la politique', () => {
  it('isSafeEmailAddress', () => {
    expect(isSafeEmailAddress('user.name+tag@sub.example.test')).toBe(true);
    expect(isSafeEmailAddress('a@b.test')).toBe(true);
    expect(isSafeEmailAddress('')).toBe(false);
    expect(isSafeEmailAddress('a@b.test '.trim() + '\t')).toBe(false);
    expect(isSafeEmailAddress('a@b')).toBe(false);
    expect(isSafeEmailAddress('@b.test')).toBe(false);
    expect(isSafeEmailAddress('a@')).toBe(false);
    expect(isSafeEmailAddress('a@b.test@c.test')).toBe(false);
    expect(isSafeEmailAddress('a\u0000@b.test')).toBe(false);
  });

  it('isSafeHeaderValue', () => {
    expect(isSafeHeaderValue('Sujet normal — avec accents')).toBe(true);
    expect(isSafeHeaderValue('a\r\nb')).toBe(false);
    expect(isSafeHeaderValue('a\nb')).toBe(false);
    expect(isSafeHeaderValue('')).toBe(false);
    expect(isSafeHeaderValue('a\u007fb')).toBe(false);
  });

  it('isInternalConfirmationPath', () => {
    expect(isInternalConfirmationPath('/contact/merci')).toBe(true);
    expect(isInternalConfirmationPath('/merci?ok=1')).toBe(true);
    expect(isInternalConfirmationPath('//evil.test')).toBe(false);
    expect(isInternalConfirmationPath('https://evil.test')).toBe(false);
    expect(isInternalConfirmationPath('mailto:x@y.test')).toBe(false);
    expect(isInternalConfirmationPath('merci')).toBe(false);
    expect(isInternalConfirmationPath('/merci\\evil')).toBe(false);
  });
});

describe('registre des formulaires', () => {
  it('résout par clé et refuse les doublons', () => {
    const registry = createContactFormRegistry({
      declarations: [
        defineContactForm(validDeclaration()),
        defineContactForm({ ...validDeclaration(), key: 'devis', label: 'Devis' }),
      ],
    });
    expect(registry.findByKey('contact')?.key).toBe('contact');
    expect(registry.findByKey('devis')?.key).toBe('devis');
    expect(registry.findByKey('inconnu')).toBeNull();
    expect(() => registry.requireByKey('inconnu')).toThrow(/non déclaré/);
    expect(() =>
      createContactFormRegistry({
        declarations: [
          defineContactForm(validDeclaration()),
          defineContactForm(validDeclaration()),
        ],
      }),
    ).toThrow(/dupliquée/);
  });

  it('revalide la forme au runtime (canal sérialisé)', () => {
    const definition = defineContactForm(validDeclaration());
    const resolved = resolveContactFormDefinition(definition);
    expect(resolved.key).toBe('contact');
    expect(() =>
      resolveContactFormDefinition({
        ...(definition as unknown as ContactFormDeclaration),
        confirmationPath: '//evil.test',
      }),
    ).toThrow(/confirmationPath/);
  });
});
