import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVercelDeployHookTrigger } from '../src/adapters/vercel/rebuild';

/**
 * Adapter Vercel (deploy hook) contre un **serveur HTTP local contrôlé**
 * (mission §36, §37) : succès, refus, indisponibilité, HTTPS imposé en
 * production, secret jamais exposé dans les résultats ni les erreurs.
 * Aucun vrai hook réseau n'est jamais appelé.
 */

let server: Server;
let baseUrl = '';
let lastMethod = '';
let lastBody = '';
let lastPath = '';
/** Comportement programmable du faux hook. */
let hookBehavior: 'ok' | 'accepted' | 'rejected' | 'garbage' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    lastMethod = req.method ?? '';
    lastPath = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      if (hookBehavior === 'ok') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Started deployment');
      } else if (hookBehavior === 'accepted') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"job":{"id":"fake"}}');
      } else if (hookBehavior === 'rejected') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('hook error details that must never leak');
      } else {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeTrigger(hookUrl = `${baseUrl}/api/v1/deploy-hook`) {
  // Dev/test : hook local http explicitement autorisé.
  return createVercelDeployHookTrigger({ hookUrl, allowInsecureHttp: true, timeoutMs: 2_000 });
}

describe('createVercelDeployHookTrigger', () => {
  it('200 → ok, requête POST avec le corps de raison', async () => {
    const trigger = makeTrigger();
    const result = await trigger.requestRebuild({ reason: 'content.published' });
    expect(result).toEqual({ ok: true, requestId: null });
    expect(lastMethod).toBe('POST');
    expect(lastPath).toBe('/api/v1/deploy-hook');
    expect(JSON.parse(lastBody)).toMatchObject({ reason: 'content.published', source: 'kreiz' });
  });

  it('202 → ok : accusé de réception, jamais « rebuild succeeded »', async () => {
    hookBehavior = 'accepted';
    try {
      const result = await makeTrigger().requestRebuild({ reason: 'manual' });
      expect(result).toEqual({ ok: true, requestId: null });
    } finally {
      hookBehavior = 'ok';
    }
  });

  it('statut non 2xx → rejected avec statusCode, sans la réponse du provider', async () => {
    hookBehavior = 'rejected';
    try {
      const result = await makeTrigger().requestRebuild({ reason: 'content.unpublished' });
      expect(result).toEqual({ ok: false, failure: { kind: 'rejected', statusCode: 503 } });
    } finally {
      hookBehavior = 'ok';
    }
  });

  it('connexion coupée → unreachable, message assaini', async () => {
    hookBehavior = 'garbage';
    try {
      const result = await makeTrigger().requestRebuild({ reason: 'content.deleted' });
      expect(result).toEqual({ ok: false, failure: { kind: 'unreachable' } });
    } finally {
      hookBehavior = 'ok';
    }
  });

  it('serveur injoignable → unreachable', async () => {
    // Port fermé : connexion refusée immédiatement.
    const trigger = createVercelDeployHookTrigger({
      hookUrl: 'http://127.0.0.1:1/hook',
      allowInsecureHttp: true,
      timeoutMs: 2_000,
    });
    const result = await trigger.requestRebuild({ reason: 'manual' });
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable' } });
  });

  it('HTTPS imposé en production (allowInsecureHttp: false)', () => {
    expect(() =>
      createVercelDeployHookTrigger({ hookUrl: 'http://hook.example/hook', allowInsecureHttp: false }),
    ).toThrow(/HTTPS/);
  });

  it('http:// accepté en dev/test (allowInsecureHttp: true)', () => {
    expect(() => makeTrigger()).not.toThrow();
  });

  it('URL invalide → erreur de construction claire', () => {
    expect(() =>
      createVercelDeployHookTrigger({ hookUrl: 'pas-une-url', allowInsecureHttp: true }),
    ).toThrow(/KREIZ_REBUILD_DEPLOY_HOOK_URL/);
  });

  it('aucun résultat ne contient jamais l’URL du hook (secret)', async () => {
    hookBehavior = 'rejected';
    try {
      const secretUrl = `${baseUrl}/secret-token-path`;
      const trigger = createVercelDeployHookTrigger({
        hookUrl: secretUrl,
        allowInsecureHttp: true,
      });
      const result = await trigger.requestRebuild({ reason: 'manual' });
      expect(JSON.stringify(result)).not.toContain('secret-token-path');
      expect(JSON.stringify(result)).not.toContain(baseUrl);
    } finally {
      hookBehavior = 'ok';
    }
  });
});
