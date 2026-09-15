import { defineContentType, fields, type InferContentTypeData } from '@kreiz/core/content';

/**
 * Type de contenu Article — déclaration **du projet de démonstration**,
 * jamais du Core (cadrage §8). `body` est un document riche structuré
 * (slice 6) : format canonique Kreiz édité par Tiptap côté admin, rendu par
 * le renderer déterministe côté public — jamais du HTML stocké.
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
    body: fields.richText({
      label: 'Corps',
      help: 'Texte intégral : titres, listes, citations, liens et images de la médiathèque.',
      required: true,
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
