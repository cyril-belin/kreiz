/**
 * Types de contenu déclarés par le projet de démonstration — passés au Core
 * via `kreiz({ content: { types: [...] } })` dans astro.config.ts.
 *
 * Ces déclarations appartiennent exclusivement à `apps/demo` : aucun
 * Article/Guide/Case Study n'est hardcodé dans @kreiz/core. Un autre projet
 * déclarerait ses propres types (Services, Équipe, Actualités…) sans
 * modifier Kreiz.
 */
export { articleType, type ArticleData } from './article.js';
export { guideType, type GuideData } from './guide.js';
export { caseStudyType, type CaseStudyData } from './case-study.js';
