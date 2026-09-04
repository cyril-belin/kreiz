import { describe, expect, it } from 'vitest';
import { kreizConfigSchema, normalizeKreizConfig } from '../src/config';

describe('kreizConfigSchema', () => {
  it('accepte une configuration de spike valide', () => {
    const config = normalizeKreizConfig({ spike: { message: 'bonjour du demo' } });
    expect(config.spike?.message).toBe('bonjour du demo');
  });

  it('accepte une configuration vide', () => {
    expect(normalizeKreizConfig({})).toEqual({});
    expect(normalizeKreizConfig(undefined)).toEqual({});
  });

  it('rejette une clé inconnue — la configuration n’est jamais ignorée silencieusement', () => {
    expect(() => kreizConfigSchema.parse({ unknownKey: true })).toThrow();
  });

  it('rejette un message de spike vide', () => {
    expect(() => kreizConfigSchema.parse({ spike: { message: '' } })).toThrow();
  });
});
