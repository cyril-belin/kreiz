import { describe, expect, it } from 'vitest';
import {
  astroRedirectsConfig,
  materializableRedirects,
  planSlugChangeRedirect,
  publicPath,
} from '../src/domain/content/redirect-engine';
import { RedirectSelfPathError } from '../src/domain/content/errors';

/**
 * Moteur de redirections — règles pures (mission §17-§26) : construction des
 * chemins, plan d'écriture normalisé (chaînes aplaties, boucles impossibles,
 * slug réapparu), matérialisation build-time (cibles vivantes uniquement).
 */

describe('publicPath', () => {
  it('construit /{namespace}/{slug}', () => {
    expect(publicPath('articles', 'mon-article')).toBe('/articles/mon-article');
  });
});

describe('planSlugChangeRedirect — création', () => {
  it('planifie une redirection simple ancien → nouveau', () => {
    const plan = planSlugChangeRedirect({
      routeNamespace: 'articles',
      previousPublicSlug: 'ancien',
      newSlug: 'nouveau',
      redirects: [],
    });
    expect(plan.fromPath).toBe('/articles/ancien');
    expect(plan.toPath).toBe('/articles/nouveau');
    expect(plan.removeStaleSources).toEqual([]);
    expect(plan.retargets).toEqual([]);
  });

  it('refuse une auto-redirection (garde défensive)', () => {
    expect(() =>
      planSlugChangeRedirect({
        routeNamespace: 'articles',
        previousPublicSlug: 'même-slug',
        newSlug: 'même-slug',
        redirects: [],
      }),
    ).toThrow(RedirectSelfPathError);
  });
});

describe('planSlugChangeRedirect — normalisation des chaînes (mission §21)', () => {
  it('/a → /b puis /b → /c donne /a → /c et /b → /c', () => {
    // État : /a → /b (créé à la publication précédente).
    const plan = planSlugChangeRedirect({
      routeNamespace: 'articles',
      previousPublicSlug: 'b',
      newSlug: 'c',
      redirects: [{ fromPath: '/articles/a', toPath: '/articles/b' }],
    });
    expect(plan.fromPath).toBe('/articles/b');
    expect(plan.toPath).toBe('/articles/c');
    expect(plan.removeStaleSources).toEqual([]);
    expect(plan.retargets).toEqual([{ fromPath: '/articles/a', toPath: '/articles/c' }]);
  });

  it('/a → /c et /b → /c puis /c → /d donne /a → /d, /b → /d, /c → /d', () => {
    const plan = planSlugChangeRedirect({
      routeNamespace: 'articles',
      previousPublicSlug: 'c',
      newSlug: 'd',
      redirects: [
        { fromPath: '/articles/a', toPath: '/articles/c' },
        { fromPath: '/articles/b', toPath: '/articles/c' },
      ],
    });
    expect(plan.retargets).toEqual([
      { fromPath: '/articles/a', toPath: '/articles/d' },
      { fromPath: '/articles/b', toPath: '/articles/d' },
    ]);
    expect(plan.removeStaleSources).toEqual([]);
  });
});

describe('planSlugChangeRedirect — boucles impossibles (mission §22)', () => {
  it('retour au slug initial : /b → /a remplace /a → /b, jamais /a → /b → /a', () => {
    // État : /a → /b (publié à b). L'admin ramène le slug à a.
    const plan = planSlugChangeRedirect({
      routeNamespace: 'articles',
      previousPublicSlug: 'b',
      newSlug: 'a',
      redirects: [{ fromPath: '/articles/a', toPath: '/articles/b' }],
    });
    // /a redevient une page : sa redirection source est supprimée…
    expect(plan.removeStaleSources).toEqual(['/articles/a']);
    // … et aucune re-cible ne touche /a (elle vient d'être supprimée).
    expect(plan.retargets).toEqual([]);
    expect(plan.fromPath).toBe('/articles/b');
    expect(plan.toPath).toBe('/articles/a');
  });

  it('cycle long a → b → c → a : aucune boucle, l’étape de suppression casse le cycle', () => {
    // État après a→b puis b→c : /a → /c, /b → /c. Retour au slug a.
    const plan = planSlugChangeRedirect({
      routeNamespace: 'articles',
      previousPublicSlug: 'c',
      newSlug: 'a',
      redirects: [
        { fromPath: '/articles/a', toPath: '/articles/c' },
        { fromPath: '/articles/b', toPath: '/articles/c' },
      ],
    });
    // /a redevient la page : sa ligne source est supprimée avant la re-cible.
    expect(plan.removeStaleSources).toEqual(['/articles/a']);
    // /b → /c est re-ciblée vers /a — pas de /a → /a possible.
    expect(plan.retargets).toEqual([{ fromPath: '/articles/b', toPath: '/articles/a' }]);
  });
});

describe('materializableRedirects — matérialisation build (mission §25, §27)', () => {
  const routes = [
    { routeNamespace: 'articles', slug: 'vivant' },
    { routeNamespace: 'guides', slug: 'guide-vivant' },
  ];

  it('émet une redirection 301 vers une cible vivante', () => {
    const result = materializableRedirects(
      [{ fromPath: '/articles/ancien', toPath: '/articles/vivant' }],
      routes,
    );
    expect(result).toEqual([
      { source: '/articles/ancien', destination: '/articles/vivant', status: 301 },
    ]);
  });

  it('n’émet pas une redirection dont la cible n’est plus publiée (dépubliée/supprimée)', () => {
    const result = materializableRedirects(
      [{ fromPath: '/articles/ancien', toPath: '/articles/morte' }],
      routes,
    );
    expect(result).toEqual([]);
  });

  it('n’émet jamais une redirection dont la source est une page vivante', () => {
    const result = materializableRedirects(
      [{ fromPath: '/articles/vivant', toPath: '/guides/guide-vivant' }],
      routes,
    );
    expect(result).toEqual([]);
  });

  it('n’émet pas une chaîne résiduelle (source qui est elle-même une cible de redirection)', () => {
    const result = materializableRedirects(
      [
        { fromPath: '/articles/a', toPath: '/articles/b' },
        { fromPath: '/articles/b', toPath: '/articles/vivant' },
      ],
      routes,
    );
    // /a → /b pointe vers une source de redirection : exclu (terminalité).
    expect(result).toEqual([
      { source: '/articles/b', destination: '/articles/vivant', status: 301 },
    ]);
  });

  it('ignore une auto-redirection et un chemin non parsable', () => {
    const result = materializableRedirects(
      [
        { fromPath: '/articles/x', toPath: '/articles/x' },
        { fromPath: 'pas-un-chemin', toPath: '/articles/vivant' },
        { fromPath: '/articles/ok', toPath: '/articles/vivant' },
      ],
      routes,
    );
    expect(result).toEqual([{ source: '/articles/ok', destination: '/articles/vivant', status: 301 }]);
  });

  it('produit une configuration Astro déterministe', () => {
    const config = astroRedirectsConfig(
      materializableRedirects(
        [
          { fromPath: '/articles/z', toPath: '/articles/vivant' },
          { fromPath: '/articles/a', toPath: '/articles/vivant' },
        ],
        routes,
      ),
    );
    expect(config).toEqual({
      '/articles/a': { destination: '/articles/vivant', status: 301 },
      '/articles/z': { destination: '/articles/vivant', status: 301 },
    });
  });
});
