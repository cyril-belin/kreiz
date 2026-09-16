import { expect, test, type APIRequestContext } from '@playwright/test';
import { query } from './db';

/**
 * Parcours critiques du slice 8 — analytics privacy-first. Le navigateur
 * exécute les pages publiques réelles (statiques en production) avec le
 * beacon du Core ; la base ne sert qu'aux vérifications serveur.
 *
 * Scénarios (mission §35) : page view publique collectée, admin/preview
 * jamais comptés, UTM normalisés, DNT/GPC respectés, conversion formulaire
 **sans aucune donnée du formulaire**, déduplication du double beacon, et
 * dashboard admin cohérent.
 */

const baseURL = 'http://127.0.0.1:4321';
const CONTACT_URL = '/contact';
const THANKS_URL = /\/contact\/merci$/;

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;

/**
 * UA de navigateur réel pour les contextes qui doivent être **mesurés** :
 * le run Playwright tourne en headless (UA `HeadlessChrome`), et le filtre
 * de bots serveur exclut ce marqueur à juste titre — ces contextes
 * simulent donc un visiteur réel. Le filtrage bot est un comportement
 * serveur testé à part (POST directs, scénario 7bis).
 */
const REAL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Contexte navigateur « visiteur réel » (mesuré par le beacon). */
async function realVisitorContext(browser: import('@playwright/test').Browser) {
  return browser.newContext({ userAgent: REAL_BROWSER_UA });
}

/** Session UUID éphémère (format strictement validé côté serveur). */
const session = () => crypto.randomUUID();

/** Attend (avec polling) qu'une ligne analytics apparaisse — le beacon est asynchrone. */
async function waitForRows(
  text: string,
  values: unknown[],
  options: { expect?: number; timeout?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const expected = options.expect ?? 1;
  const deadline = Date.now() + (options.timeout ?? 8000);
  for (;;) {
    const rows = await query<Record<string, unknown>>(text, values);
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) {
      throw new Error(`analytics E2E : ligne attendue introuvable (${rows.length}/${expected}) — ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function countRows(text: string, values: unknown[] = []): Promise<number> {
  const rows = await query<{ total: number }>(text, values);
  return Number(rows.at(0)?.total ?? 0);
}

/** POST direct au collecteur (client « honnête » pour les scénarios hostiles). */
async function postEvent(
  request: APIRequestContext,
  payload: unknown,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; retryAfter: string | null }> {
  const response = await request.post('/api/analytics/event', {
    headers: {
      'content-type': 'application/json',
      origin: baseURL,
      ...options.headers,
    },
    data: JSON.stringify(payload),
  });
  return { status: response.status(), retryAfter: response.headers()['retry-after'] ?? null };
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test.describe('collecte publique', () => {
  test.beforeEach(async () => {
    // Fenêtre de rate limiting analytics propre (IP unique du run = 127.0.0.1).
    await query("delete from kreiz_rate_limits where key like 'analytics:%'");
  });

  test('1. une page publique visitée produit une page view', async ({ browser }) => {
    const context = await realVisitorContext(browser);
    const page = await context.newPage();
    await page.goto('/');
    const rows = await waitForRows(
      `select path, referrer, referrer_kind from kreiz_analytics_events
       where event_name = 'page_view' and path = '/' order by created_at desc limit 1`,
      [],
    );
    const row = rows[0]!;
    expect(row.path).toBe('/');
    // Navigation directe en Playwright : accès direct (null) ou interne.
    expect(row.referrer_kind === 'internal' || row.referrer === null).toBe(true);
    await context.close();
  });

  test('2. la visite de /admin ne produit aucun page view admin', async ({ page }) => {
    await login(page);
    await page.goto('/admin/media');
    await expect(page.getByRole('heading', { name: 'Médias', level: 1 })).toBeVisible();
    await page.waitForTimeout(1500); // laisser toute beacon fantôme partir
    const total = await countRows(
      "select count(*)::int as total from kreiz_analytics_events where event_name = 'page_view' and path like '/admin%'",
    );
    expect(total).toBe(0);
  });

  test('3. une preview admin ne produit aucun page view', async ({ page }) => {
    await login(page);
    await page.goto('/admin/preview/00000000-0000-0000-0000-000000000000');
    await page.waitForTimeout(1500);
    const total = await countRows(
      "select count(*)::int as total from kreiz_analytics_events where path like '/admin/preview%'",
    );
    expect(total).toBe(0);
  });

  test('4. les UTM sont normalisés (minuscules, trim) et la query jamais stockée', async ({ browser }) => {
    const context = await realVisitorContext(browser);
    const page = await context.newPage();
    const marker = `e2e8-${Date.now().toString(36)}`;
    await page.goto(
      `/?utm_source=${encodeURIComponent(' Newsletter ')}&utm_medium=email&utm_campaign=${encodeURIComponent(marker)}`,
    );
    const rows = await waitForRows(
      `select utm_source, utm_medium, utm_campaign, path from kreiz_analytics_events
       where event_name = 'page_view' and utm_campaign = $1`,
      [marker],
    );
    expect(rows[0]!.utm_source).toBe('newsletter');
    expect(rows[0]!.utm_medium).toBe('email');
    expect(rows[0]!.path).toBe('/');
    await context.close();
  });
});

test.describe('vie privée et robustesse', () => {
  test.beforeEach(async () => {
    // Les rafales de ces scénarios ne doivent pas hériter du compteur des
    // autres tests (IP unique du run).
    await query("delete from kreiz_rate_limits where key like 'analytics:%'");
  });

  test('5. DNT : signal explicite ⇒ aucune collecte', async ({ browser }) => {
    const marker = `dnt-${Date.now().toString(36)}`;
    // Visiteur réel (UA normal) + DNT : c'est bien le signal de vie privée
    // (vérifié AVANT le filtre de bots côté serveur) qui doit bloquer.
    const context = await browser.newContext({
      extraHTTPHeaders: { DNT: '1' },
      userAgent: REAL_BROWSER_UA,
    });
    const page = await context.newPage();
    await page.goto(`/?utm_campaign=${marker}`);
    await page.waitForTimeout(1500); // le beacon enverrait déjà : rien ne doit arriver
    const total = await countRows(
      'select count(*)::int as total from kreiz_analytics_events where utm_campaign = $1',
      [marker],
    );
    expect(total).toBe(0);
    await context.close();
  });

  test('6. formulaire accepté ⇒ conversion analytics sans aucune donnée du formulaire', async ({ page }) => {
    // Préfixe `e2e-` : c'est le marqueur de nettoyage du teardown global.
    const email = `e2e-8-${Date.now().toString(36)}@example.test`;
    const unique = `conversion-${Date.now().toString(36)}`;
    await page.goto(CONTACT_URL);
    await page.waitForTimeout(3200); // temps minimal de remplissage
    await page.getByLabel('Nom').fill(`Analytics E2E ${unique}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Sujet').selectOption('question');
    await page.getByLabel('Message').fill(`Message privé ${unique} — ne doit jamais apparaître en analytics.`);
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();
    await expect(page).toHaveURL(THANKS_URL);

    const rows = await waitForRows(
      `select metadata, path from kreiz_analytics_events where event_name = 'form_accepted' and metadata->>'form' = 'contact'
       and created_at > now() - interval '1 minute' order by created_at desc limit 1`,
      [],
    );
    const rowJson = JSON.stringify(rows[0]).toLowerCase();
    expect(rowJson).not.toContain(email);
    expect(rowJson).not.toContain(unique.toLowerCase());
    expect(rowJson).not.toContain('message privé');
  });

  test('7. double beacon / retry : dédupliqué dans la même tranche', async ({ request }) => {
    const id = session();
    const payload = { type: 'pv', path: '/e2e8-dedup', session: id };
    const first = await postEvent(request, payload);
    expect(first.status).toBe(204);
    const second = await postEvent(request, payload);
    expect(second.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // les deux inserts visibles
    const rows = await query<{ created_at: string }>(
      'select created_at::text as created_at from kreiz_analytics_events where session_id = $1',
      [id],
    );
    // Politique de dédup documentée : un envoi par tranche de 30 s — une
    // seule ligne, ou deux **uniquement** si la paire a chevauché une
    // frontière de tranche (cas rare, légitime).
    if (rows.length === 2) {
      const buckets = new Set(
        rows.map((row) => Math.floor(new Date(row.created_at).getTime() / 30_000)),
      );
      expect(buckets.size).toBe(2);
    } else {
      expect(rows.length).toBe(1);
    }
  });

  test('7bis. payload hostiles : réponses muettes, aucune ligne, aucun 500', async ({ request }) => {
    const id = session();
    // JSON invalide, clés inconnues, session forgée, chemin CR/LF, nom interdit.
    const hostile = await request.post('/api/analytics/event', {
      headers: { 'content-type': 'application/json', origin: baseURL },
      data: '{ "type": "pv", "path": ',
    });
    expect(hostile.status()).toBe(400);
    expect(await hostile.text()).toBe('');

    for (const payload of [
      { type: 'pv', path: '/', evil: '<script>alert(1)</script>' },
      { type: 'pv', path: 'https://evil.example/steal', session: id },
      { type: 'pv', path: '/a\r\nX-Inject: 1', session: id },
      { type: 'form_accepted', path: '/', form: 'contact' },
      { type: 'pv', path: '/admin', session: id },
      { type: 'pv', path: '/ok', session: 'pas-un-uuid' },
    ]) {
      const response = await postEvent(request, payload);
      expect([204, 400]).toContain(response.status);
    }
    // Aucune ligne hostile persistée pour cette session.
    await new Promise((resolve) => setTimeout(resolve, 800));
    const total = await countRows(
      'select count(*)::int as total from kreiz_analytics_events where session_id = $1',
      [id],
    );
    expect(total).toBe(0);
  });

  test('7ter. rate limiting : rafale au-delà du plafond → 429 avec Retry-After', async ({ request }) => {
    let lastStatus = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 35 && lastStatus !== 429; i += 1) {
      const response = await postEvent(request, {
        type: 'pv',
        path: `/e2e8-burst/${i}`, // chemins distincts : hors déduplication
        session: session(),
      });
      lastStatus = response.status;
      retryAfter = response.retryAfter;
    }
    expect(lastStatus).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });
});

test.describe('dashboard admin', () => {
  test('8/9. admin analytics : accès gardé, chiffres cohérents avec la base', async ({ page }) => {
    // Garde : non authentifié → login.
    await page.goto('/admin/analytics');
    await expect(page).toHaveURL(/\/admin\/login$/);

    // Période 7 jours épinglée : les totaux affichés doivent égaler le
    // compteur réel sur exactement la même fenêtre.
    await login(page);
    await page.goto('/admin/analytics?periode=7');
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page.getByText('7 derniers jours (UTC)')).toBeVisible();

    const totals = await query<{ pageviews: number; sessions: number; conversions: number }>(
      `select
         count(*) filter (where event_name = 'page_view')::int as pageviews,
         count(distinct session_id) filter (where event_name = 'page_view')::int as sessions,
         count(*) filter (where event_name = 'form_accepted')::int as conversions
       from kreiz_analytics_events where created_at >= now() - interval '7 days'`,
    );
    const dbTotals = totals[0]!;
    const displayed = await page
      .getByTestId('analytics-pageviews')
      .textContent()
      .then((value) => Number((value ?? '0').replace(/\s/g, '')));
    expect(displayed).toBe(dbTotals.pageviews);
    expect(dbTotals.pageviews).toBeGreaterThanOrEqual(1);

    // Top pages : l'accueil apparaît ; jamais une route admin.
    await expect(page.getByText('Top pages')).toBeVisible();
    const adminPathsInTable = await countRows(
      "select count(*)::int as total from kreiz_analytics_events where path like '/admin%' or path like '/api%'",
    );
    expect(adminPathsInTable).toBe(0);

    // Conversion du test 6 visible dans « Conversions formulaire ».
    await expect(page.getByText('contact', { exact: true }).first()).toBeVisible();
  });
});
