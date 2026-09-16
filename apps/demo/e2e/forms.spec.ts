import { expect, type Page, test } from '@playwright/test';
import { query } from './db';
import { capturedMails, resetMailCaptures, setMailFailMode } from './mail-capture-server';

/**
 * Parcours critiques du slice 7 — formulaires de contact. Le navigateur
 * exécute la page publique réelle (statique en production, rendue par
 * requête en dev) ; la base ne sert qu'aux effets serveur (demandes
 * stockées, états de notification) et à la préparation d'états (purge du
 * rate limiting partagé par l'IP unique du run).
 *
 * Scénarios : soumission valide + notification, fonctionnement **sans
 * JavaScript**, validation serveur stricte, idempotence (double soumission),
 * anti-spam (honeypot, jeton, remplissage instantané), jeton falsifié,
 * origine croisée refusée, tentative d'open relay / injection d'en-têtes,
 * panne du transport sans perte de la demande + relance admin, accès admin
 * non authentifié refusé.
 */

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const baseURL = 'http://127.0.0.1:4321';

const CONTACT_URL = '/contact';
const THANKS_URL = /\/contact\/merci$/;

/** Marqueur e2e- pour le nettoyage final (payload->>'email'). */
let markerSeq = 0;
function marker(): string {
  markerSeq += 1;
  return `e2e-${Date.now().toString(36)}-${markerSeq}@example.test`;
}

/** Temps minimal de remplissage (politique du Core) — attendu avant chaque soumission UI. */
async function waitMinFill(page: Page): Promise<void> {
  await page.waitForTimeout(3200);
}

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

/** Jeton d'émission extrait du HTML de la page contact (frais : âge ≈ 0). */
async function tokenFromPage(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const response = await request.get(CONTACT_URL);
  const html = await response.text();
  const match = html.match(/name="form_token" value="([^"]+)"/);
  if (!match) throw new Error('form_token introuvable dans la page contact');
  return match[1]!;
}

/** Jeton âgé du temps minimal de remplissage — pour les POST directs « honnêtes ». */
async function agedTokenFromPage(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const token = await tokenFromPage(request);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  return token;
}

interface PostOptions {
  origin?: string | null;
  fields?: Record<string, string>;
}

/** POST direct urlencoded — client « curl honnête » pour les scénarios hostiles. */
async function postContact(
  request: import('@playwright/test').APIRequestContext,
  fields: Record<string, string>,
  options: PostOptions = {},
): Promise<{ status: number; location: string | null; body: string }> {
  const body = new URLSearchParams(fields).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.origin !== null) {
    headers.origin = options.origin ?? baseURL;
  }
  const response = await request.post('/api/forms/contact', {
    headers,
    // `data` (et non `body` — ignoré par l'APIRequestContext de Playwright) :
    // le corps urlencodé doit réellement partir, comme un formulaire HTML.
    data: body,
    maxRedirects: 0, // observer la 303, pas la suivre
  });
  return {
    status: response.status(),
    location: response.headers().location ?? null,
    body: await response.text(),
  };
}

async function countRequests(email: string): Promise<number> {
  const rows = await query<{ total: number }>(
    "select count(*)::int as total from kreiz_contact_requests where payload->>'email' = $1",
    [email],
  );
  return rows[0]!.total;
}

async function lastRequest(email: string): Promise<{
  id: string;
  status: string;
  notification_status: string;
  notification_attempts: number;
  notified_at: string | null;
  payload: Record<string, unknown>;
}> {
  const rows = await query<{
    id: string;
    status: string;
    notification_status: string;
    notification_attempts: number;
    notified_at: string | null;
    payload: Record<string, unknown>;
  }>(
    "select id, status, notification_status, notification_attempts, notified_at::text, payload from kreiz_contact_requests where payload->>'email' = $1 order by created_at desc limit 1",
    [email],
  );
  return rows[0]!;
}

test.beforeEach(async () => {
  // Fenêtre de rate limiting propre (IP unique du run = 127.0.0.1) et
  // relais en mode normal, captures purgées.
  await query("delete from kreiz_rate_limits where key like 'contact:%'");
  await setMailFailMode(false);
  await resetMailCaptures();
});

test.describe('soumission valide', () => {
  test('parcours UI complet : formulaire → merci → demande stockée + notification envoyée', async ({ page }) => {
    const email = marker();
    await page.goto(CONTACT_URL);
    await waitMinFill(page);
    await page.getByLabel('Nom').fill('Alice E2E');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Sujet').selectOption('quote');
    await page.getByLabel('Message').fill('Bonjour, un test E2E de bout en bout.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();

    await expect(page).toHaveURL(THANKS_URL);

    // La demande est stockée avec le payload validé.
    const row = await lastRequest(email);
    expect(row.status).toBe('new');
    expect(row.notification_status).toBe('sent');
    expect(row.notified_at).toBeTruthy();
    expect(row.payload.subject).toBe('quote');

    // L'enveloppe email : destinataire = déclaration, reply-to = champ email.
    const mails = await capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual([{ email: 'bonjour@kreiz-demo.example' }]);
    expect(mails[0]!.replyTo?.email).toBe(email);
    expect(mails[0]!.subject).toBe('Nouveau message — site Kreiz demo');
    expect(mails[0]!.text).toContain('Bonjour, un test E2E de bout en bout.');
    expect(mails[0]!.from.email).toBe('no-reply@kreiz-demo.example');
  });

  test('fonctionne sans JavaScript (contexte JS désactivé)', async ({ browser }) => {
    const email = marker();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(CONTACT_URL);
    await waitMinFill(page);
    await page.getByLabel('Nom').fill('NoJS E2E');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Sujet').selectOption('question');
    await page.getByLabel('Message').fill('Soumission sans JavaScript.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();

    await expect(page).toHaveURL(THANKS_URL);
    const row = await lastRequest(email);
    expect(row.notification_status).toBe('sent');
    await context.close();
  });

  test('double soumission (double-clic simulé) : une seule demande, deux réponses succès', async ({ page, request }) => {
    const email = marker();
    await page.goto(CONTACT_URL);
    const token = await tokenFromPage(request);
    const fields = {
      form_token: token,
      name: 'Double E2E',
      email,
      subject: 'other',
      message: 'Premier envoi',
      consent: 'true',
    };
    await waitMinFill(page); // le jeton vient de la page chargée
    const first = await postContact(request, fields);
    expect(first.status).toBe(303);
    const second = await postContact(request, fields);
    expect(second.status).toBe(303); // succès idempotent, pas d'erreur
    expect(await countRequests(email)).toBe(1);
  });
});

test.describe('validation serveur stricte', () => {
  test('champs requis manquants → 422, erreurs par champ, aucune ligne', async ({ request }) => {
    const email = marker();
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, { form_token: token, email });
    expect(response.status).toBe(422);
    expect(response.body).toContain('Ce champ est requis.');
    expect(response.body).toContain('name="form_token"');
    expect(await countRequests(email)).toBe(0);
  });

  test('email invalide → 422 avec valeur conservée pour correction', async ({ request }) => {
    const email = marker();
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Alice',
      email: 'pas-une-adresse',
      subject: 'question',
      message: 'correction attendue',
      consent: 'true',
    });
    expect(response.status).toBe(422);
    expect(response.body).toContain('Adresse email invalide.');
    // Les valeurs valides sont re-rendues pour correction.
    expect(response.body).toContain('value="Alice"');
    expect(await countRequests(email)).toBe(0);
  });

  test('consentement non coché → 422 (RGPD)', async ({ request }) => {
    const email = marker();
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Alice',
      email,
      subject: 'question',
      message: 'sans consentement',
    });
    expect(response.status).toBe(422);
    expect(response.body).toContain('Vous devez cocher cette case.');
    expect(await countRequests(email)).toBe(0);
  });
});

test.describe('anti-spam et protections', () => {
  test('honeypot rempli → 303 comme un succès, mais aucune demande stockée', async ({ request }) => {
    const email = marker();
    const token = await tokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Bot',
      email,
      subject: 'question',
      message: 'spam',
      consent: 'true',
      website: 'http://spam.example',
    });
    expect(response.status).toBe(303);
    expect(response.location).toBe('/contact/merci');
    expect(await countRequests(email)).toBe(0);
  });

  test('soumission instantanée après le rendu → silence, aucune demande', async ({ request }) => {
    const email = marker();
    const token = await tokenFromPage(request); // jeton frais (rendu à la requête en dev)
    const response = await postContact(request, {
      form_token: token,
      name: 'Bot rapide',
      email,
      subject: 'question',
      message: 'trop vite',
      consent: 'true',
    });
    expect(response.status).toBe(303); // silence total : aucun indice
    expect(await countRequests(email)).toBe(0);
  });

  test('jeton falsifié → 403 explicite', async ({ request }) => {
    const email = marker();
    const parts = (await tokenFromPage(request)).split('.');
    const forged = `${parts[0]}.${Buffer.from('contact|1000000000').toString('base64url')}.${parts[2]}`;
    const response = await postContact(request, {
      form_token: forged,
      name: 'Falsificateur',
      email,
      subject: 'question',
      message: 'x',
      consent: 'true',
    });
    expect(response.status).toBe(403);
    expect(await countRequests(email)).toBe(0);
  });

  test('jeton absent → 403 ; jeton d’un autre formulaire → 403', async ({ request }) => {
    const email = marker();
    const response = await postContact(request, {
      name: 'X',
      email,
      subject: 'question',
      message: 'x',
      consent: 'true',
    });
    expect(response.status).toBe(403);

    // Jeton signé mais pour une autre clé de formulaire (même secret, autre
    // cible) : le service doit le refuser (wrong-form).
    const { issueFormToken } = await import('@kreiz/core/forms');
    const { kreizSecret } = await import('./env');
    const otherFormToken = issueFormToken({ formKey: 'autre', secret: kreizSecret }).token;
    const wrongForm = await postContact(request, {
      form_token: otherFormToken,
      name: 'X',
      email,
      subject: 'question',
      message: 'x',
      consent: 'true',
    });
    expect(wrongForm.status).toBe(403);
    expect(await countRequests(email)).toBe(0);
  });

  test('POST cross-origin → 403 (anti-CSRF, jamais relayé)', async ({ request }) => {
    const email = marker();
    const token = await tokenFromPage(request);
    const response = await postContact(
      request,
      { form_token: token, name: 'X', email, subject: 'question', message: 'x', consent: 'true' },
      { origin: 'https://site-externe.example' },
    );
    expect([403]).toContain(response.status);
    expect(await countRequests(email)).toBe(0);
  });

  test('rate limiting : au-delà de 5 soumissions par fenêtre → 429 avec Retry-After', async ({ request, page }) => {
    test.setTimeout(120_000);
    await page.goto(CONTACT_URL);
    await waitMinFill(page);
    const token = await tokenFromPage(request);
    let lastStatus = 0;
    for (let index = 0; index < 7; index += 1) {
      const response = await postContact(request, {
        form_token: token,
        name: `Rafale ${index}`,
        email: marker(),
        subject: 'question',
        message: `message ${index}`,
        consent: 'true',
      });
      lastStatus = response.status;
      if (response.status === 429) {
        expect(response.body).toContain('Trop de messages');
        break;
      }
      await page.waitForTimeout(3100); // respecter le temps minimal de remplissage
    }
    expect(lastStatus).toBe(429);
  });
});

test.describe('anti open-relay et injection', () => {
  test('clé de formulaire inconnue → 404 sec', async ({ request }) => {
    const body = new URLSearchParams({ name: 'X', email: marker() }).toString();
    const response = await request.post('/api/forms/inconnu', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseURL },
      data: body,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });

  test('tentative d’override des destinataires et du sujet → ignorée, enveloppe intacte', async ({ request }) => {
    const email = marker();
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Injecteur',
      email,
      subject: 'question',
      message: 'tentative d’override',
      consent: 'true',
      recipients: 'victim@evil.example',
      to: 'victim@evil.example',
      bcc: 'victim@evil.example',
      cc: 'victim@evil.example',
    });
    expect(response.status).toBe(303);
    const mails = await capturedMails();
    const mail = mails.at(-1);
    expect(mail).toBeTruthy();
    expect(mail!.to).toEqual([{ email: 'bonjour@kreiz-demo.example' }]);
    expect(JSON.stringify(mail)).not.toContain('victim@evil.example');
    expect(mail!.subject).toBe('Nouveau message — site Kreiz demo');
  });

  test('injection d’en-têtes via le champ email (CRLF) → refus de validation', async ({ request }) => {
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Injecteur',
      email: 'a@b.test\r\nBcc: victim@evil.example',
      subject: 'question',
      message: 'injection',
      consent: 'true',
    });
    expect(response.status).toBe(422);
    expect(response.body).toContain('Adresse email invalide.');
    const mails = await capturedMails();
    expect(JSON.stringify(mails)).not.toContain('victim@evil.example');
  });
});

test.describe('panne du transport email — aucune perte', () => {
  test('relais en échec : soumission quand même acceptée, demande failed, relance admin OK', async ({ page }) => {
    const email = marker();

    // 1. Le relais renvoie 503 : la soumission doit être un succès utilisateur.
    await setMailFailMode(true);
    await page.goto(CONTACT_URL);
    await waitMinFill(page);
    await page.getByLabel('Nom').fill('Panne E2E');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Sujet').selectOption('question');
    await page.getByLabel('Message').fill('Soumis pendant une panne du transport.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();
    await expect(page).toHaveURL(THANKS_URL); // jamais d'erreur visible de l'expéditeur

    let row = await lastRequest(email);
    expect(row.notification_status).toBe('failed');
    expect(row.notification_attempts).toBe(1);
    expect(row.notified_at).toBeNull();

    // 2. Côté admin : la demande est visible, marquée en échec, relançable.
    await login(page);
    await page.goto('/admin/forms');
    await expect(page.getByRole('heading', { name: 'Boîte de contact', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Consulter' }).first().click();
    await expect(page.getByText(/Échec après 1 tentative/)).toBeVisible();

    // 3. Le relais est rétabli : relance de la notification.
    await setMailFailMode(false);
    await resetMailCaptures();
    await page.getByRole('button', { name: 'Renvoyer la notification' }).click();
    await expect(page.getByText('Notification envoyée.')).toBeVisible();

    row = await lastRequest(email);
    expect(row.notification_status).toBe('sent');
    expect(row.notified_at).toBeTruthy();
    const mails = await capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.replyTo?.email).toBe(email);
  });

  test('marquer une demande comme traitée depuis la boîte', async ({ page }) => {
    const email = marker();
    // Soumission directe via l'UI (transport en mode normal).
    await page.goto(CONTACT_URL);
    await waitMinFill(page);
    await page.getByLabel('Nom').fill('Traitement E2E');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Sujet').selectOption('other');
    await page.getByLabel('Message').fill('À marquer traitée.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();
    await expect(page).toHaveURL(THANKS_URL);

    await login(page);
    await page.goto('/admin/forms?status=new');
    // La demande du test est la plus récente de la boîte.
    await page.getByRole('link', { name: 'Consulter' }).first().click();
    await expect(page.getByText('Traitement E2E')).toBeVisible();
    await page.getByRole('button', { name: 'Marquer comme traitée' }).click();
    await expect(page.getByText('État de la demande mis à jour.')).toBeVisible();
    const dbRow = await lastRequest(email);
    expect(dbRow.status).toBe('handled');
    // L'événement d'audit est écrit.
    const audit = await query<{ total: number }>(
      "select count(*)::int as total from kreiz_admin_audit_log where action = 'contact.status_changed' and entity_id = $1",
      [dbRow.id],
    );
    expect(audit[0]!.total).toBe(1);
  });
});

test.describe('contrôle d’accès admin', () => {
  test('boîte de contact non authentifiée → redirection login', async ({ page }) => {
    await page.goto('/admin/forms');
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test('mutation de statut non authentifiée → refus, aucune modification', async ({ request }) => {
    const rows = await query<{ id: string }>(
      'select id from kreiz_contact_requests order by created_at desc limit 1',
    );
    const body = new URLSearchParams({ status: 'handled' }).toString();
    const response = await request.post(`/admin/forms/${rows[0]?.id ?? '00000000-0000-0000-0000-000000000000'}/status`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: baseURL },
      data: body,
      maxRedirects: 0,
    });
    expect([303, 401, 403]).toContain(response.status());
    if (response.status() === 303) {
      expect(response.headers().location).toContain('/admin/login');
    }
  });

  test('l’endpoint public de soumission ne consomme jamais la session admin', async ({ page, request }) => {
    // Un visiteur authentifié admin qui soumet le formulaire public reste
    // sur le flux public (pas de garde admin, pas de redirection).
    await login(page);
    const email = marker();
    const token = await agedTokenFromPage(request);
    const response = await postContact(request, {
      form_token: token,
      name: 'Admin aussi visiteur',
      email,
      subject: 'question',
      message: 'flux public',
      consent: 'true',
    });
    expect(response.status).toBe(303);
    expect(await countRequests(email)).toBe(1);
  });
});
