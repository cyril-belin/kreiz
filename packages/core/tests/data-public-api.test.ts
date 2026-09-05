import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createKreizDatabase } from '../src/data/connection';

describe('carte exports de @kreiz/core — frontière mécanique du slice 0', () => {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { exports: Record<string, unknown> };

  it('n’expose que les points d’entrée publics — aucun deep import possible', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      ['.', './data', './package.json', './virtual'].sort(),
    );
  });
});

describe('createKreizDatabase', () => {
  it('construit une instance Drizzle côté serveur, sans contacter la base', () => {
    const db = createKreizDatabase({
      databaseUrl: 'postgresql://user:secret@localhost:5432/kreiz_test',
    });
    expect(typeof db.select).toBe('function');
    expect(typeof db.insert).toBe('function');
    expect(typeof db.execute).toBe('function');
    // Le driver Neon est attaché à l'instance : la connexion ne se fait qu'à
    // la première requête (driver HTTP), jamais à l'import ni à la factory.
    expect(db.$client).toBeDefined();
  });
});

describe('propriété des migrations', () => {
  it('@kreiz/core ne possède aucune migration ni journal Drizzle', () => {
    expect(existsSync(fileURLToPath(new URL('../drizzle', import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL('../drizzle.config.ts', import.meta.url)))).toBe(false);
  });
});
