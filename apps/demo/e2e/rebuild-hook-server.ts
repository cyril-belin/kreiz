import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Serveur de deploy hook **local contrôlé** pour l'E2E (mission §45 —
 * « sans lancer un vrai Vercel ») : le serveur dev d'Astro est démarré avec
 * `KREIZ_REBUILD_DEPLOY_HOOK_URL` pointant ici. Chaque publication /
 * dépublication / rebuild manuel arrive comme un vrai POST HTTP — le fil
 * complet admin → service → port → adapter → hook est prouvé, sans
 * déploiement externe.
 *
 * Le serveur vit dans le processus du runner Playwright (démarré par le
 * global-setup, arrêté par le global-teardown) ; les workers le consultent
 * via HTTP.
 */

export type CapturedHookRequest = {
  path: string;
  body: Record<string, unknown>;
  at: string;
};

let server: Server | null = null;
const captured: CapturedHookRequest[] = [];
let failMode = false;

export const HOOK_PORT = 43_990;
export const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/hook`;

/** Démarre le serveur de hook (idempotent). */
export function startHookServer(): void {
  if (server) return;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url === '/hook') {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { raw };
        }
        captured.push({ path: req.url ?? '', body, at: new Date().toISOString() });
        if (failMode) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('hook indisponible (mode échec E2E)');
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('Started deployment');
        }
        return;
      }
      if (req.method === 'GET' && req.url === '/__captured') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(captured));
        return;
      }
      if (req.method === 'POST' && req.url === '/__reset') {
        captured.length = 0;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/__mode') {
        let mode: { fail?: boolean } = {};
        try {
          mode = JSON.parse(raw) as { fail?: boolean };
        } catch {
          // ignore
        }
        failMode = mode.fail === true;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(HOOK_PORT, '127.0.0.1');
}

/** Arrête le serveur et purge l'état. */
export async function stopHookServer(): Promise<void> {
  if (!server) return;
  const closing = new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  captured.length = 0;
  await closing;
}

/** Toutes les requêtes de hook capturées jusque-là. */
export async function capturedHookRequests(): Promise<CapturedHookRequest[]> {
  const response = await fetch(`http://127.0.0.1:${HOOK_PORT}/__captured`);
  return (await response.json()) as CapturedHookRequest[];
}

/** Purge les captures (entre deux parcours). */
export async function resetHookCaptures(): Promise<void> {
  await fetch(`http://127.0.0.1:${HOOK_PORT}/__reset`, { method: 'POST' });
}

/** Bascule le mode « hook en échec » (503) — scénario de récupération. */
export async function setHookFailMode(fail: boolean): Promise<void> {
  await fetch(`http://127.0.0.1:${HOOK_PORT}/__mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail }),
  });
}

/** Utilitaire de diagnostic (port effectif). */
export function hookAddress(): AddressInfo | null {
  return server?.address() as AddressInfo | null;
}
