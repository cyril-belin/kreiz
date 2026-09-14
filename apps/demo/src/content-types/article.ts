import { defineContentType, fields, type InferContentTypeData } from '@kreiz/core/content';

/**
 * Type de contenu Article — déclaration **du projet de démonstration**,
 * jamais du Core (cadrage §8). Champs spécifiques simples ; `body` est un
 * textarea simple au slice 3 (le rich text Tiptap arrive au slice 6, le
 * descripteur restera valable).
 */
export const articleType = defineContentType({
  key: 'article',
  label: 'Article',
  labelPlural: 'Articles',
  routeNamespace: 'articles',
  fields: {
    excerpt: fields.text({
      label: 'Accroche',
      help: 'Résumé court affiché en tête d’article.',
      required: true,
      maxLength: 300,
    }),
    body: fields.textarea({
      label: 'Corps',
      help: 'Texte intégral. Paragraphes séparés par des lignes vides.',
      required: true,
      maxLength: 20_000,
    }),
    author: fields.text({
      label: 'Auteur',
      required: true,
      maxLength: 120,
    }),
  },
  template: 'src/templates/ArticleContent.astro',
});

export type ArticleData = InferContentTypeData<typeof articleType>;
