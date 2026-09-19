import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebhookMailer } from '../src/adapters/mailer/webhook';

/**
 * Adapter relais webhook — contrat du port `Mailer` : POST JSON du message
 * préparé, mapping honnête des échecs (unreachable / rejected), Bearer
 * optionnel, HTTPS imposé hors dev. Aucun SaaS : un serveur HTTP local.
 */

const email = {
  from: { email: 'no-reply@example.test', name: 'Kreiz' },
  to: [{ email: 'dest@example.test' }],
  replyTo: { email: 'alice@example.test' },
  subject: 'Sujet',
  text: 'Corps du message',
};

let server: Server;
let captured: Array<{ auth: string | null; body: string }> = [];
let status = 200;
let respondBody = 'OK';
let dropConnections = false;
let redirectLocation: string | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        auth: req.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (dropConnections) {
        res.destroy();
        return;
      }
      res.writeHead(status, {
        'content-type': 'text/plain',
        'x-kreiz-message-id': 'transport-42',
        ...(redirectLocation ? { location: redirectLocation } : {}),
      });
      res.end(respondBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function localUrl(): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/relay`;
}

describe('createWebhookMailer', () => {
  it('envoie le message préparé en POST JSON et retourne ok + messageId', async () => {
    captured = [];
    status = 200;
    const mailer = createWebhookMailer({ webhookUrl: localUrl(), allowInsecureHttp: true });
    const result = await mailer.send(email);
    expect(result).toEqual({ ok: true, messageId: 'transport-42' });
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body.from).toEqual({ email: 'no-reply@example.test', name: 'Kreiz' });
    expect(body.to).toEqual([{ email: 'dest@example.test' }]);
    expect(body.replyTo).toEqual({ email: 'alice@example.test' });
    expect(body.subject).toBe('Sujet');
    expect(body.text).toContain('Corps');
  });

  it('porte le token Bearer quand il est configuré, jamais sinon', async () => {
    captured = [];
    const withToken = createWebhookMailer({
      webhookUrl: localUrl(),
      token: 'jeton-secret',
      allowInsecureHttp: true,
    });
    await withToken.send(email);
    expect(captured[0]!.auth).toBe('Bearer jeton-secret');

    captured = [];
    const withoutToken = createWebhookMailer({ webhookUrl: localUrl(), allowInsecureHttp: true });
    await withoutToken.send(email);
    expect(captured[0]!.auth).toBeNull();
  });

  it('statut non 2xx → rejected avec statusCode (jamais le corps de la réponse)', async () => {
    captured = [];
    status = 503;
    respondBody = 'détail interne du transport';
    const mailer = createWebhookMailer({ webhookUrl: localUrl(), allowInsecureHttp: true });
    const result = await mailer.send(email);
    expect(result).toEqual({ ok: false, failure: { kind: 'rejected', statusCode: 503 } });
  });

  it('connexion coupée → unreachable (erreur assainie)', async () => {
    captured = [];
    dropConnections = true;
    const mailer = createWebhookMailer({
      webhookUrl: localUrl(),
      allowInsecureHttp: true,
      timeoutMs: 2000,
    });
    const result = await mailer.send(email);
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable' } });
    dropConnections = false;
  });

  it('URL injoignable (port mort) → unreachable', async () => {
    const mailer = createWebhookMailer({
      webhookUrl: 'http://127.0.0.1:9/relay',
      allowInsecureHttp: true,
      timeoutMs: 1000,
    });
    const result = await mailer.send(email);
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable' } });
  });

  it('HTTPS imposé hors dev — http refusé à la construction', () => {
    expect(() =>
      createWebhookMailer({ webhookUrl: 'http://relay.example.test/x', allowInsecureHttp: false }),
    ).toThrow(/HTTPS/);
    expect(() =>
      createWebhookMailer({ webhookUrl: 'http://127.0.0.1:1/x', allowInsecureHttp: true }),
    ).not.toThrow();
    expect(() => createWebhookMailer({ webhookUrl: 'ftp://x', allowInsecureHttp: true })).toThrow();
    expect(() => createWebhookMailer({ webhookUrl: 'pas-une-url', allowInsecureHttp: true })).toThrow(
      /invalide/,
    );
  });

  it('ne suit jamais une redirection (revue sécurité finale) — un 3xx est un refus', async () => {
    // Un relais compromis qui répond 302 ne doit ni faire suivre le corps
    // (PII visiteur) vers un autre hôte, ni le faire retomber en HTTP clair.
    captured = [];
    status = 302;
    redirectLocation = 'http://attacker.example/payload';
    const mailer = createWebhookMailer({ webhookUrl: localUrl(), allowInsecureHttp: true });
    const result = await mailer.send(email);
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.kind === 'rejected') {
      expect(result.failure.statusCode).toBe(302);
    }
    // Une seule requête reçue : le fetch n'a pas suivi la redirection.
    expect(captured).toHaveLength(1);
    redirectLocation = null;
    status = 200;
  });
});
