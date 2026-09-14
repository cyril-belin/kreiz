import { defineContentType, fields, type InferContentTypeData } from '@kreiz/core/content';

/**
 * Type de contenu Guide — déclaration du projet de démonstration. Le champ
 * `difficulty` démontre le select fermé : les choix sont déclarés en code,
 * jamais éditables depuis l'admin.
 */
export const guideType = defineContentType({
  key: 'guide',
  label: 'Guide',
  labelPlural: 'Guides',
  routeNamespace: 'guides',
  fields: {
    excerpt: fields.text({
      label: 'Accroche',
      help: 'Résumé court affiché en tête de guide.',
      required: true,
      maxLength: 300,
    }),
    body: fields.textarea({
      label: 'Corps',
      help: 'Texte intégral. Paragraphes séparés par des lignes vides.',
      required: true,
      maxLength: 20_000,
    }),
    difficulty: fields.select({
      label: 'Difficulté',
      required: true,
      choices: [
        { value: 'debutant', label: 'Débutant' },
        { value: 'intermediaire', label: 'Intermédiaire' },
        { value: 'avance', label: 'Avancé' },
      ],
    }),
  },
  template: 'src/templates/GuideContent.astro',
});

export type GuideData = InferContentTypeData<typeof guideType>;
