import { describe, expect, it } from 'vitest';
import { parseContactSubmission, contactPayloadTooLarge, renderContactFormWithErrors } from '../src/http/public-form';
import { defineContactForm } from '../src/domain/forms/declaration';
import { formFields } from '../src/domain/forms/fields';
import { issueFormToken } from '../src/domain/forms/token';
import { CONTACT_PAYLOAD_MAX_BYTES } from '../src/domain/forms/policy';

/**
 * Parseur HTTP des soumissions publiques — whitelist stricte : le honeypot
 * n'est jamais lu comme valeur, le jeton est extrait à part, tout champ non
 * déclaré est ignoré (tentative d'override d'enveloppe incluse).
 */

const form = defineContactForm({
  key: 'contact',
  label: 'Contact',
  fields: {
    name: formFields.text({ label: 'Nom', required: true }),
    email: formFields.email({ label: 'Email', required: true }),
    consent: formFields.consent({ label: 'C', checkboxLabel: 'OK', required: true }),
  },
  confirmationPath: '/merci',
});

const SECRET = 'secret-de-test-tres-long-0123456789abcdef';
const token = issueFormToken({ formKey: 'contact', secret: SECRET }).token;

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.append(key, value);
  }
  return data;
}

describe('parseContactSubmission', () => {
  it('extrait champs déclarés, jeton et honeypot', () => {
    const parsed = parseContactSubmission(
      form,
      formData({
        form_token: token,
        name: '  Alice ',
        email: 'a@b.test',
        consent: 'on',
        website: '',
      }),
    );
    expect(parsed.values).toEqual({ name: 'Alice', email: 'a@b.test', consent: true });
    expect(parsed.token).toBe(token);
    expect(parsed.honeypotFilled).toBe(false);
    expect(parsed.unexpectedFieldCount).toBe(0);
  });

  it('honeypot rempli = signal, valeur jamais lue', () => {
    const parsed = parseContactSubmission(
      form,
      formData({ form_token: token, website: 'http://spam.example' }),
    );
    expect(parsed.honeypotFilled).toBe(true);
    expect(parsed.values.website).toBeUndefined();
  });

  it('champs non déclarés ignorés — tentatives d’override d’enveloppe comprises', () => {
    const parsed = parseContactSubmission(
      form,
      formData({
        form_token: token,
        name: 'x',
        email: 'a@b.test',
        consent: 'on',
        recipients: 'victim@evil.test',
        to: 'victim@evil.test',
        bcc: 'victim@evil.test',
        form_id: 'autre',
        subject: 'Spam',
      }),
    );
    expect(parsed.values).toEqual({ name: 'x', email: 'a@b.test', consent: true });
    expect(parsed.unexpectedFieldCount).toBe(5);
  });

  it('consent non coché = false, cochée = true (on ou true)', () => {
    const unchecked = parseContactSubmission(form, formData({ consent: '' }));
    expect(unchecked.values.consent).toBe(false);
    const checkedTrue = parseContactSubmission(form, formData({ consent: 'true' }));
    expect(checkedTrue.values.consent).toBe(true);
  });

  it('jeton absent = chaîne vide', () => {
    const parsed = parseContactSubmission(form, formData({ name: 'x' }));
    expect(parsed.token).toBe('');
  });

  it('tronque défensivement une entrée géante avant le schéma', () => {
    const parsed = parseContactSubmission(
      form,
      formData({ name: 'x'.repeat(500_000) }),
    );
    expect((parsed.values.name as string).length).toBeLessThanOrEqual(100_000);
  });
});

describe('borne de taille agrégée du payload', () => {
  it('refuse au-delà de CONTACT_PAYLOAD_MAX_BYTES', () => {
    const small = contactPayloadTooLarge({ name: 'x' });
    expect(small).toBe(false);
    const giant: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      giant[`f${index}`] = 'y'.repeat(10_000);
    }
    expect(Object.keys(giant).length * 10_000).toBeGreaterThan(CONTACT_PAYLOAD_MAX_BYTES / 2);
    expect(contactPayloadTooLarge(giant)).toBe(true);
  });
});

describe('renderContactFormWithErrors — re-rendu serveur', () => {
  it('produit une page HTML contenant le formulaire et les erreurs', () => {
    const freshToken = issueFormToken({ formKey: 'contact', secret: SECRET }).token;
    const html = renderContactFormWithErrors({
      form,
      submittedToken: freshToken,
      secret: SECRET,
      now: new Date(),
      values: { name: 'Alice' },
      fieldErrors: { email: 'Ce champ est requis.' },
    });
    expect(html).toContain('<form method="post"');
    expect(html).toContain('Ce champ est requis.');
    expect(html).toContain('value="Alice"');
  });

  it('re-signe un jeton invalide en jeton frais (sans crash)', () => {
    const html = renderContactFormWithErrors({
      form,
      submittedToken: 'jeton-falsifié',
      secret: SECRET,
      now: new Date(),
      values: {},
      fieldErrors: { name: 'Ce champ est requis.' },
    });
    expect(html).toContain('name="form_token"');
  });

  it('caractères non stockables en JSONB (NUL, substituts isolés) rejetés en validation — jamais un 500 (revue sécurité finale)', () => {
    // PostgreSQL refuse \u0000 et les substituts non appariés en jsonb
    // (erreur 22021) : sans garde de schéma, la soumission 500 au lieu de
    // renvoyer une erreur de champ propre.
    const schema = form.payloadSchema;
    expect(schema.safeParse({ name: 'Alice\u0000B', email: 'a@b.test', consent: true }).success).toBe(false);
    expect(schema.safeParse({ name: 'A\uD800B', email: 'a@b.test', consent: true }).success).toBe(false);
    // CRLF reste légitime dans un champ texte multiligne.
    expect(schema.safeParse({ name: 'Alice', email: 'a@b.test', consent: true }).success).toBe(true);
  });
});
