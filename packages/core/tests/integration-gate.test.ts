import { describe, expect, it } from 'vitest';
import { resolveIntegrationGate } from './integration/helpers';

/**
 * **Preuve anti faux vert** (passe de fermeture) : le gate des tests
 * d'intégration doit échouer bruyamment en CI sans base — jamais sauter
 * silencieusement. La matrice est pure et exécutée partout, y compris dans
 * le job `quality` sans secrets.
 */
describe('resolveIntegrationGate — plus jamais de faux vert en CI', () => {
  it('base configurée → exécution (local comme job d\'intégration)', () => {
    expect(resolveIntegrationGate('neon-http')).toBe('run');
    expect(resolveIntegrationGate('postgres')).toBe('run');
    expect(resolveIntegrationGate('neon-http', { requireDb: '1' })).toBe('run');
  });

  it('base absente, local ou job quality → skip (unitaires jouables sans PostgreSQL, forks verts)', () => {
    expect(resolveIntegrationGate(null)).toBe('skip');
    expect(resolveIntegrationGate(null, { requireDb: undefined })).toBe('skip');
    expect(resolveIntegrationGate(null, { requireDb: '0' })).toBe('skip');
  });

  it('base absente + KREIZ_REQUIRE_INTEGRATION_DB=1 → échec explicite (le job integration prouve qu\'il a tourné)', () => {
    expect(resolveIntegrationGate(null, { requireDb: '1' })).toBe('fail');
  });
});
