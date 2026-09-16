import { createServer, type Server } from 'node:http';

/**
 * Serveur de relais email **local contrôlé** pour l'E2E (slice 7 — même
 * mécanique que le deploy hook : le serveur dev Astro est démarré avec
 * `KREIZ_MAIL_WEBHOOK_URL` pointant ici). Chaque notification de contact
 * arrive comme un vrai POST HTTP JSON (from/to/replyTo/subject/text) — le
 * fil complet service → port `Mailer` → adapter webhook → transport est
 * prouvé sans aucun SaaS ni credential.
 *
 * Le serveur vit dans le processus du runner Playwright (démarré par le
 * global-setup, arrêté par le global-teardown) ; les workers le consultent
 * via HTTP.
 */

export type CapturedMail = {
  from: { email: string; name?: string };
  to: Array<{ email: string }>;
  replyTo: { email: string } | null;
  subject: string;
  text: string;
  at: string;
};

let server: Server | null = null;
const captured: CapturedMail[] = [];
let failMode = false;

export const MAIL_PORT = 43_992;
export const MAIL_URL = `http://127.0.0.1:${MAIL_PORT}/relay`;

/** Démarre le serveur de relais (idempotent). */
export function startMailServer(): void {
  if (server) return;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url === '/relay') {
        let body: Partial<CapturedMail> = {};
        try {
          body = JSON.parse(raw) as Partial<CapturedMail>;
        } catch {
          body = {};
        }
        captured.push({ ...(body as CapturedMail), at: new Date().toISOString() });
        if (failMode) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('relais indisponible (mode échec E2E)');
        } else {
          res.writeHead(200, { 'content-type': 'text/plain', 'x-kreiz-message-id': 'e2e-mail-1' });
          res.end('Queued');
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
  server.listen(MAIL_PORT, '127.0.0.1');
}

/** Arrête le serveur et purge l'état. */
export async function stopMailServer(): Promise<void> {
  if (!server) return;
  const closing = new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  captured.length = 0;
  await closing;
}

/** Tous les messages capturés jusque-là. */
export async function capturedMails(): Promise<CapturedMail[]> {
  const response = await fetch(`http://127.0.0.1:${MAIL_PORT}/__captured`);
  return (await response.json()) as CapturedMail[];
}

/** Purge les captures (entre deux parcours). */
export async function resetMailCaptures(): Promise<void> {
  await fetch(`http://127.0.0.1:${MAIL_PORT}/__reset`, { method: 'POST' });
}

/** Bascule le mode « relais en échec » (503) — scénario de récupération. */
export async function setMailFailMode(fail: boolean): Promise<void> {
  await fetch(`http://127.0.0.1:${MAIL_PORT}/__mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail }),
  });
}
