import { defineContactForm, formFields } from '@kreiz/core/forms';

/**
 * Formulaire de contact du projet de démonstration — déclaration **du
 * projet**, jamais du Core (cadrage §13). Le vocabulaire de champs est
 * borné ; les destinataires et le sujet sont du **code de confiance** :
 * aucune entrée visiteur ne devient une adresse d'enveloppe.
 */
export const contactForm = defineContactForm({
  key: 'contact',
  label: 'Contact',
  description: 'Écrivez-nous — nous répondons sous deux jours ouvrés.',
  fields: {
    name: formFields.text({
      label: 'Nom',
      required: true,
      maxLength: 120,
      autocomplete: 'name',
    }),
    email: formFields.email({
      label: 'Email',
      required: true,
      autocomplete: 'email',
    }),
    subject: formFields.select({
      label: 'Sujet',
      required: true,
      choices: [
        { value: 'question', label: 'Question générale' },
        { value: 'quote', label: 'Demande de devis' },
        { value: 'other', label: 'Autre' },
      ],
    }),
    message: formFields.textarea({
      label: 'Message',
      required: true,
      maxLength: 2000,
      placeholder: 'Votre message…',
    }),
    consent: formFields.consent({
      label: 'Consentement',
      required: true,
      checkboxLabel:
        'J’accepte que mes données soient utilisées pour traiter ma demande (aucun autre usage).',
    }),
  },
  confirmationPath: '/contact/merci',
  submitLabel: 'Envoyer le message',
  notification: {
    recipients: ['bonjour@kreiz-demo.example'],
    subject: 'Nouveau message — site Kreiz demo',
  },
});
