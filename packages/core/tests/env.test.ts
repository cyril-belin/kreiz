import { describe, expect, it } from 'vitest';
import { kreizDatabaseEnvSchema, parseKreizDatabaseEnv } from '../src/data/env';

describe('parseKreizDatabaseEnv', () => {
  it('accepte un environnement contenant une URL PostgreSQL valide', () => {
    const env = parseKreizDatabaseEnv({
      KREIZ_DATABASE_URL: 'postgresql://user:secret@ep-test.eu-central-1.aws.neon.tech/kreiz',
      AUTRE_VARIABLE: 'ignorée',
    });
    expect(env.KREIZ_DATABASE_URL).toBe(
      'postgresql://user:secret@ep-test.eu-central-1.aws.neon.tech/kreiz',
    );
  });

  it('accepte aussi le préfixe postgres://', () => {
    expect(() => parseKreizDatabaseEnv({ KREIZ_DATABASE_URL: 'postgres://localhost/kreiz' })).not.toThrow();
  });

  it('rejette un environnement sans KREIZ_DATABASE_URL', () => {
    expect(() => parseKreizDatabaseEnv({})).toThrow(/KREIZ_DATABASE_URL/);
  });

  it('rejette une URL non PostgreSQL — le navigateur comme les drivers étrangers ne passent pas', () => {
    expect(() => parseKreizDatabaseEnv({ KREIZ_DATABASE_URL: 'mysql://localhost/kreiz' })).toThrow();
    expect(() =>
      parseKreizDatabaseEnv({ KREIZ_DATABASE_URL: 'https://example.neon.tech/db' }),
    ).toThrow();
  });

  it('rejette une valeur qui n’est pas une URL', () => {
    expect(() => parseKreizDatabaseEnv({ KREIZ_DATABASE_URL: 'pas-une-url' })).toThrow();
    expect(() => parseKreizDatabaseEnv({ KREIZ_DATABASE_URL: 42 })).toThrow();
  });

  it('le schéma brut ignore les variables inconnues sans les valider', () => {
    const parsed = kreizDatabaseEnvSchema.safeParse({
      KREIZ_DATABASE_URL: 'postgresql://localhost/kreiz',
      PATH: '/usr/bin',
    });
    expect(parsed.success).toBe(true);
  });
});
