import { describe, expect, it } from 'vitest';
import {
  normalizeSlugInput,
  resolveGeneratedSlug,
  slugCandidates,
  slugify,
  SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
} from '../src/domain/content/slug';

/**
 * Règles pures des slugs (mission §11) — normalisation Unicode raisonnable,
 * minuscules, séparateurs cohérents, jamais vide, suffixage `foo`, `foo-2`,
 * `foo-3`. La collision en base (namespace, soft-deleted libéré) est couverte
 * par les tests d'intégration ; ici la mécanique pure.
 */

describe('slugify', () => {
  it('minuscule, accents retirés, séparateurs cohérents', () => {
    expect(slugify('Mon Super Article !')).toBe('mon-super-article');
    expect(slugify('Éditorial : les fondamentaux')).toBe('editorial-les-fondamentaux');
    expect(slugify('À propos de l’œuvre')).toBe('a-propos-de-l-oeuvre');
  });

  it('gère les cas Unicode courants (ligatures, caractères nordiques)', () => {
    expect(slugify('Œuvre d’Ægir à Ålesund')).toBe('oeuvre-d-aegir-a-alesund');
    expect(slugify('Straße & Fuß')).toBe('strasse-fuss');
  });

  it('compacte les séparateurs et supprime les tirets de bord', () => {
    expect(slugify('  --  Deux   mots  --  ')).toBe('deux-mots');
    expect(slugify('???')).toBe('');
  });

  it('tronque à la longueur maximale sans terminer par un tiret', () => {
    expect(slugify('a'.repeat(150) + '-fin')).toBe('a'.repeat(SLUG_MAX_LENGTH));
    // La troncature ne laisse jamais un tiret en bout.
    expect(slugify('a'.repeat(SLUG_MAX_LENGTH - 1) + '-x')).toBe('a'.repeat(SLUG_MAX_LENGTH - 1));
  });
});

describe('normalizeSlugInput — saisie manuelle', () => {
  it('applique le même pipeline que le slug automatique', () => {
    expect(normalizeSlugInput('  Mon Slug Choisi  ')).toBe('mon-slug-choisi');
    expect(normalizeSlugInput('Déjà/Un:Chemin?')).toBe('deja-un-chemin');
    expect(normalizeSlugInput('***')).toBe('');
  });
});

describe('suffixage', () => {
  it('le premier candidat n’est jamais suffixé', () => {
    expect([...slugCandidates('foo')].slice(0, 3)).toEqual(['foo', 'foo-2', 'foo-3']);
  });

  it('resolveGeneratedSlug prend le premier slug libre du namespace', async () => {
    const taken = new Set(['foo', 'foo-2']);
    const slug = await resolveGeneratedSlug('foo', (candidate) =>
      Promise.resolve(taken.has(candidate)),
    );
    expect(slug).toBe('foo-3');
  });

  it('resolveGeneratedSlug retourne null si tout est pris (borné)', async () => {
    const slug = await resolveGeneratedSlug('foo', () => Promise.resolve(true));
    expect(slug).toBeNull();
  });

  it('repli non vide pour un titre sans caractère sluggable', () => {
    expect(slugify('??') || SLUG_FALLBACK).toBe('contenu');
  });
});
