import { describe, expect, it } from 'vitest';
import { createNoopRebuildTrigger } from '../src/ports/rebuild';
import { createKreizAdminRuntime, kreizAdminEnvSchema, parseKreizAdminEnv } from '../src/http/server-env';

/**
 * Environnement de reconstruction (mission §9-§10) : la variable est
 * optionnelle (absence d'adapter = état normal), le port répond
 * `not-configured`, et l'URL du hook — secret — n'apparaît dans aucun
 * objet exposé au-delà du port.
 */

const baseEnv = {
  KREIZ_DATABASE_URL: 'postgresql://user:pass@ep-test.example/test',
  KREIZ_SECRET: 'x'.repeat(32),
};

describe('environnement rebuild', () => {
  it('KREIZ_REBUILD_DEPLOY_HOOK_URL est optionnelle', () => {
    const parsed = parseKreizAdminEnv(baseEnv);
    expect(parsed.rebuildHookUrl).toBeNull();
  });

  it('l’URL du hook est extraite quand elle est fournie', () => {
    const parsed = parseKreizAdminEnv({
      ...baseEnv,
      KREIZ_REBUILD_DEPLOY_HOOK_URL: 'https://api.vercel.com/v1/integrations/deploy/abc',
    });
    expect(parsed.rebuildHookUrl).toBe('https://api.vercel.com/v1/integrations/deploy/abc');
  });

  it('une valeur non URL est rejetée', () => {
    const parsed = kreizAdminEnvSchema.safeParse({
      ...baseEnv,
      KREIZ_REBUILD_DEPLOY_HOOK_URL: 'pas-une-url',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('createKreizAdminRuntime — câblage du port', () => {
  it('sans hook : provider null + port not-configured', async () => {
    const runtime = createKreizAdminRuntime(parseKreizAdminEnv(baseEnv));
    expect(runtime.rebuildProvider).toBeNull();
    const result = await runtime.rebuild.requestRebuild({ reason: 'manual' });
    expect(result).toEqual({ ok: false, failure: { kind: 'not-configured' } });
  });

  it('avec hook : provider déclaré — l’URL reste confinée au port (jamais logguée ni rendue)', () => {
    const runtime = createKreizAdminRuntime(
      parseKreizAdminEnv({
        ...baseEnv,
        KREIZ_REBUILD_DEPLOY_HOOK_URL: 'https://api.vercel.com/v1/integrations/deploy/secret-token',
      }),
      { allowInsecureRebuildHook: false },
    );
    expect(runtime.rebuildProvider).toBe('vercel-deploy-hook');
    // Aucune surface du runtime n'expose l'URL.
    expect(JSON.stringify(runtime.rebuildProvider)).not.toContain('secret-token');
  });
});

describe('createNoopRebuildTrigger', () => {
  it('répond not-configured sans effet de bord', async () => {
    const trigger = createNoopRebuildTrigger();
    const result = await trigger.requestRebuild({ reason: 'content.published' });
    expect(result).toEqual({ ok: false, failure: { kind: 'not-configured' } });
  });
});
