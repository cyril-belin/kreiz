declare module 'virtual:kreiz/config' {
  import type { KreizConfig } from './config.js';
  import type { KreizTemplateComponent } from './domain/content/registry.js';

  /**
   * Configuration sérialisée fournie par l'application consommatrice.
   */
  const config: KreizConfig;
  export default config;

  /**
   * Composants de template du Project, résolus par l'intégration et
   * importés statiquement — `contentTemplates[type.key]`. Le registre
   * runtime (`getContentRegistry()`) joint ces composants aux déclarations
   * sérialisées ; le Core n'importe jamais un template par chemin interne
   * au Project.
   */
  export const contentTemplates: Readonly<Record<string, KreizTemplateComponent>>;
}
