import type { MailAddress, Mailer, MailerSendResult, OutgoingEmail } from '../../ports/mailer.js';

/**
 * Adapter de référence du port `Mailer` — **relais webhook** (cadrage §13 :
 * « aucun fournisseur obligatoire »).
 *
 * Le message préparé par le service (from/to/reply-to/subject/text) part en
 * POST JSON vers une URL contrôlée par le Project (`KREIZ_MAIL_WEBHOOK_URL`)
 * : un petit endpoint interne, un routeur email, un worker SMTP — le
 * transport final appartient au Project. Aucun SDK, aucune dépendance
 * SaaS ; l'adapter sert aussi d'adapter de **dev/test** : en E2E, l'URL
 * pointe un serveur local contrôlé qui capture les messages et simule les
 * pannes — tout le flux port ⇄ adapter ⇄ transport est proué sans
 * credential externe.
 *
 * Sécurité (mêmes règles que le deploy hook, mission §37) :
 * - l'URL vient de l'**environnement runtime** (validée dans
 *   `http/server-env.ts`) — jamais de la config client, jamais d'une saisie ;
 * - **HTTPS imposé en production** (relâché explicitement en dev/test pour
 *   un relais local `http://127.0.0.1`) ;
 * - `Authorization: Bearer` optionnel (`KREIZ_MAIL_WEBHOOK_TOKEN`, secret) ;
 * - l'URL et le token ne sont jamais loggués, jamais rendus, jamais inclus
 *   dans une erreur ni un audit (les échecs portent un `kind` et un statut).
 */
export function createWebhookMailer(options: {
  /** URL du relais (secret porteur) — fournie par l'env runtime du Project. */
  webhookUrl: string;
  /** Token porteur optionnel (`Authorization: Bearer …`). */
  token?: string | null;
  /** Autoriser `http://` (développement et tests contre un relais local). */
  allowInsecureHttp: boolean;
  /** Injection pour les tests — défaut : fetch global. */
  fetchFn?: typeof fetch;
  /** Injection pour les tests — défaut : 10 s (une notification ne bloque pas l'expéditeur au-delà). */
  timeoutMs?: number;
}): Mailer {
  let parsed: URL;
  try {
    parsed = new URL(options.webhookUrl);
  } catch {
    throw new Error(
      '@kreiz/core : KREIZ_MAIL_WEBHOOK_URL invalide — une URL absolue de relais email est attendue.',
    );
  }
  if (parsed.protocol !== 'https:' && !(options.allowInsecureHttp && parsed.protocol === 'http:')) {
    throw new Error(
      '@kreiz/core : KREIZ_MAIL_WEBHOOK_URL doit utiliser HTTPS en production (relais secret porteur de messages).',
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async send(email: OutgoingEmail): Promise<MailerSendResult> {
      let response: Response;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (options.token) {
          headers.authorization = `Bearer ${options.token}`;
        }
        response = await fetchFn(parsed, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from: serializeAddress(email.from),
            to: email.to.map(serializeAddress),
            ...(email.replyTo ? { replyTo: serializeAddress(email.replyTo) } : {}),
            subject: email.subject,
            text: email.text,
          }),
          // Jamais suivre une redirection (revue sécurité finale) : le corps
          // POST porte des PII visiteur et l'en-tête un token porteur — un
          // relais qui répond 3xx (compromis, mal configuré) ne doit pouvoir
          // ni rediriger la charge vers un autre hôte, ni la faire retomber
          // en HTTP clair. Le statut 3xx est traité comme un refus du relais.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Erreur réseau/timeout : message assaini — ni l'URL ni la pile.
        return { ok: false, failure: { kind: 'unreachable' } };
      }
      if (!response.ok) {
        return { ok: false, failure: { kind: 'rejected', statusCode: response.status } };
      }
      // Identifiant transport éventuel — informatif, jamais requis.
      const messageId = response.headers.get('x-kreiz-message-id');
      return { ok: true, messageId: messageId && messageId.length <= 255 ? messageId : null };
    },
  };
}

function serializeAddress(address: MailAddress): { email: string; name?: string } {
  return address.name ? { email: address.email, name: address.name } : { email: address.email };
}
