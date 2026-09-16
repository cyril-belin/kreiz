import { describe, expect, it } from 'vitest';
import { renderContactFormHtml } from '../src/domain/forms/render';
import { defineContactForm } from '../src/domain/forms/declaration';
import { formFields } from '../src/domain/forms/fields';
import { issueFormToken } from '../src/domain/forms/token';
import { publicFormSubmitPath } from '../src/domain/forms/policy';

/**
 * Rendu HTML public — progressif (aucun JS requis), échappement strict,
 * honeypot présent mais masqué, jeton embarqué, conservation des valeurs et
 * des erreurs au re-rendu.
 */

const form = defineContactForm({
  key: 'contact',
  label: 'Contact',
  description: 'Écrivez-nous <vite>',
  fields: {
    name: formFields.text({
      label: 'Nom & prénom',
      required: true,
      autocomplete: 'name',
      maxLength: 120,
    }),
    email: formFields.email({ label: 'Email', required: true }),
    topic: formFields.select({
      label: 'Sujet',
      required: true,
      choices: [
        { value: 'a', label: 'Choix "A"' },
        { value: 'b', label: '<B>' },
      ],
    }),
    message: formFields.textarea({ label: 'Message', required: true }),
    consent: formFields.consent({ label: 'C', checkboxLabel: 'J’accepte', required: true }),
  },
  confirmationPath: '/merci',
});

const SECRET = 'secret-de-test-tres-long-0123456789abcdef';
const token = issueFormToken({ formKey: form.key, secret: SECRET }).token;

describe('renderContactFormHtml', () => {
  it('produit un POST classique vers l’endpoint public, sans aucun script', () => {
    const html = renderContactFormHtml({ form, token });
    expect(html).toContain(`<form method="post" action="${publicFormSubmitPath('contact')}"`);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onsubmit');
    expect(html).not.toContain('onclick');
  });

  it('embarque le jeton d’émission dans un champ caché dédié', () => {
    const html = renderContactFormHtml({ form, token });
    expect(html).toContain('name="form_token"');
    expect(html).toContain(`value="${token}"`);
  });

  it('champ honeypot masqué (hidden + hors tabulation + aria-hidden)', () => {
    const html = renderContactFormHtml({ form, token });
    expect(html).toContain('<div hidden aria-hidden="true">');
    expect(html).toMatch(/<input type="text"[^>]*name="website"[^>]*tabindex="-1"/);
  });

  it('échappe tout le texte interpolé (labels, options, description)', () => {
    const html = renderContactFormHtml({ form, token });
    expect(html).toContain('Écrivez-nous &lt;vite&gt;');
    expect(html).toContain('Nom &amp; prénom');
    expect(html).toContain('&lt;B&gt;');
    expect(html).toContain('Choix &quot;A&quot;');
    expect(html).not.toContain('<vite>');
    expect(html).not.toContain('<B>');
  });

  it('re-rend les valeurs soumises et les erreurs, avec aria invalid', () => {
    const html = renderContactFormHtml({
      form,
      token,
      values: {
        values: { name: 'Alice <script>', consent: true },
        fieldErrors: { email: 'Ce champ est requis.' },
        formError: null,
      },
    });
    expect(html).toContain('value="Alice &lt;script&gt;"');
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain('<p class="kz-form__error" id="kz-form-contact-email-error" role="alert">Ce champ est requis.</p>');
    expect(html).toContain('aria-invalid="true"');
    // Le select re-rend le choix conservé.
    const selectHtml = renderContactFormHtml({
      form,
      token,
      values: { values: { topic: 'b' }, fieldErrors: {}, formError: null },
    });
    expect(selectHtml).toContain('<option value="b" selected>');
  });

  it('erreur générale de formulaire rendue en role=alert', () => {
    const html = renderContactFormHtml({
      form,
      token,
      values: { values: {}, fieldErrors: {}, formError: 'Trop de messages envoyés.' },
    });
    expect(html).toContain('Trop de messages envoyés.');
  });

  it('textarea conserve les valeurs multi-lignes échappées', () => {
    const html = renderContactFormHtml({
      form,
      token,
      values: { values: { message: 'Ligne 1\n<script>x</script>' }, fieldErrors: {}, formError: null },
    });
    expect(html).toContain('Ligne 1\n&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });
});
