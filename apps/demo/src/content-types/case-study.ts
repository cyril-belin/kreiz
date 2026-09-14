import { defineContentType, fields, type InferContentTypeData } from '@kreiz/core/content';

/**
 * Type de contenu Case Study — déclaration du projet de démonstration. La
 * liste de métriques (`results`) démontre le champ `list` typé : paires
 * label/valeur éditées en lignes fixes dans l'admin, rendues en grille par
 * le template.
 */
export const caseStudyType = defineContentType({
  key: 'case_study',
  label: 'Case Study',
  labelPlural: 'Réalisations',
  routeNamespace: 'realisations',
  fields: {
    shortDescription: fields.text({
      label: 'Description courte',
      required: true,
      maxLength: 300,
    }),
    category: fields.select({
      label: 'Catégorie',
      required: true,
      choices: [
        { value: 'site-vitrine', label: 'Site vitrine' },
        { value: 'e-commerce', label: 'E-commerce' },
        { value: 'application', label: 'Application' },
      ],
    }),
    context: fields.textarea({
      label: 'Contexte',
      required: true,
      maxLength: 10_000,
    }),
    solution: fields.textarea({
      label: 'Solution',
      required: true,
      maxLength: 10_000,
    }),
    results: fields.list({
      label: 'Résultats',
      help: 'Chiffres clés du projet (libellé + valeur).',
      required: true,
      maxItems: 10,
      item: fields.metric({ label: 'Résultat' }),
    }),
  },
  template: 'src/templates/CaseStudyContent.astro',
});

export type CaseStudyData = InferContentTypeData<typeof caseStudyType>;
