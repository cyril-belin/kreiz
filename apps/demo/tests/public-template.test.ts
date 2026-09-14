import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Preuve structurelle du **template partagé preview ⇄ public** (mission §21/§23).
 *
 * La preview SSR du Core (`/admin/preview/[id]`) rend le composant fourni
 * par le registre — celui importé par le module virtuel depuis le chemin
 * `template` déclaré. Les pages publiques importent leurs templates
 * directement. Ce garde mécanise l'invariant restant : **le chemin déclaré
 * par chaque type est exactement le fichier importé par sa page publique**
 * — un seul module de template par type, aucune copie parallèle du rendu.
 *
 * (L'autre moitié de la preuve est dynamique : l'E2E preview et le test de
 * build public assertent les mêmes marqueurs de template dans le HTML rendu.)
 */

const demoRoot = fileURLToPath(new URL('../', import.meta.url));

const cases = [
  {
    key: 'article',
    declaration: 'src/content-types/article.ts',
    page: 'src/pages/articles/[slug].astro',
    template: 'src/templates/ArticleContent.astro',
  },
  {
    key: 'guide',
    declaration: 'src/content-types/guide.ts',
    page: 'src/pages/guides/[slug].astro',
    template: 'src/templates/GuideContent.astro',
  },
  {
    key: 'case_study',
    declaration: 'src/content-types/case-study.ts',
    page: 'src/pages/realisations/[slug].astro',
    template: 'src/templates/CaseStudyContent.astro',
  },
] as const;

describe('template partagé preview ⇄ public — un seul module par type', () => {
  for (const testCase of cases) {
    it(`le template déclaré par « ${testCase.key} » est exactement celui importé par sa page publique`, () => {
      // 1. Le chemin déclaré par defineContentType pointe sur le vrai fichier.
      const declarationSource = readFileSync(resolve(demoRoot, testCase.declaration), 'utf8');
      const declared = declarationSource.match(/template:\s*'([^']+)'/);
      expect(declared, `chemin template déclaré dans ${testCase.declaration}`).not.toBeNull();
      const declaredPath = resolve(demoRoot, declared![1]!);
      expect(declaredPath).toBe(resolve(demoRoot, testCase.template));
      expect(existsSync(declaredPath), `template introuvable : ${declaredPath}`).toBe(true);

      // 2. La page publique importe exactement ce fichier (et elle est
      //    bien prérendue).
      const pageFile = resolve(demoRoot, testCase.page);
      const pageSource = readFileSync(pageFile, 'utf8');
      const imported = pageSource.match(/import\s+\w+\s+from\s+'([^']+\.astro)'\s*;/);
      expect(imported, `import du template dans ${testCase.page}`).not.toBeNull();
      const importedPath = resolve(dirname(pageFile), imported![1]!);
      expect(importedPath).toBe(declaredPath);
      expect(pageSource).toContain('prerender = true');
    });
  }
});
