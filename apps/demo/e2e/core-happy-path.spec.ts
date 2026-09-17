import { expect, type Page, test } from '@playwright/test';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sharp from 'sharp';
import { query } from './db';
import { bodyText } from './richtext';
import { capturedHookRequests, resetHookCaptures } from './rebuild-hook-server';

/**
 * E2E GLOBAL (slice 10) — le parcours métier complet de bout en bout, **à
 * travers les modules** : admin bootstrappé par le CLI (global-setup) →
 * login → média → article riche (texte + image insérée + couverture) →
 * Publish → site public rendu (rich text, cover, SEO, beacon) → analytics
 * → formulaire de contact → conversion → boîte admin → modification
 * Save-sans-Publish (public inchangé) → republier (public suit).
 *
 * Ce spec ne re-teste pas les invariants déjà couverts par les specs par
 * slice (publication.spec, richtext.spec, seo.spec…) : il prouve que les
 * briques **composent** — que l'histoire d'un rédacteur réel traverse tous
 * les modules sans couture visible. C'est la preuve de non-régression
 * globale du Core.
 *
 * État partagé entre tests : fichier (convention des autres specs — un
 * redémarrage de worker réimporte le module).
 *
 * Note dev server (même workaround documenté que seo.spec) : Astro
 * mémoïse `getStaticPaths` par route — une page publiée après réchauffement
 * exige une invalidation (touch) avant visite. Comportement dev uniquement.
 */

// Hors de l'arbre observé par le dev server (contrairement aux specs par
// slice, ce spec écrit son état entre CHAQUE test : une écriture dans
// apps/demo/e2e/ provoquerait un « vite program reload » au milieu du test
// suivant — page rejouée, formulaire vidé, login soumis vide).
const STATE_FILE = join(tmpdir(), 'kreiz-core-happy-path-state.json');

type JourneyState = {
  slug: string;
  entryId: string;
  coverId: string;
  bodyMediaId: string;
  contactEmail: string;
};

function saveState(state: JourneyState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function readState(): JourneyState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as JourneyState;
}

const PUBLIC_ROUTE_FILES = ['src/pages/articles/[slug].astro'].map((file) =>
  join(process.cwd(), file),
);

function refreshPublicRoutes(): void {
  const now = new Date();
  for (const file of PUBLIC_ROUTE_FILES) {
    utimesSync(file, now, now);
  }
}

/** Visite publique avec invalidation dev — retourne le HTML servi brut. */
async function gotoPublicArticle(page: Page, path: string): Promise<string> {
  refreshPublicRoutes();
  await page.waitForTimeout(1500);
  let response = await page.goto(path);
  if (response?.status() === 404) {
    await page.waitForTimeout(2500);
    refreshPublicRoutes();
    await page.waitForTimeout(1500);
    response = await page.goto(path);
  }
  const status = response?.status() ?? 0;
  if (status !== 200) {
    throw new Error(`Page publique ${path} attendue en 200, reçu ${status}`);
  }
  return (await response?.text()) ?? '';
}

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const siteUrl = 'http://127.0.0.1:4321';
const runId = Math.random().toString(36).slice(2, 8);
const slug = `e2e-happy-${runId}`;
/** UA de navigateur réel : le filtre de bots serveur exclut HeadlessChrome. */
const REAL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

function entryIdFromUrl(url: string): string {
  return url.split('?')[0]!.split('/').at(-1) ?? '';
}

/** Attend (polling) qu'une ligne apparaisse — le beacon est asynchrone. */
async function waitForRows(
  text: string,
  values: unknown[],
  timeout = 8000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const rows = await query<Record<string, unknown>>(text, values);
    if (rows.length >= 1) return rows;
    if (Date.now() > deadline) {
      throw new Error(`ligne attendue introuvable — ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

test.describe('Kreiz Core — parcours global de bout en bout (slice 10)', () => {
  test('1. média : la médiathèque reçoit une couverture prête à publier', async ({
    page,
  }) => {
    await login(page);

    // Upload direct navigateur → S3 local → variantes → ready (pipeline réel).
    await page.goto('/admin/media');
    const before = await page.locator('.kz-media-card', { hasText: 'Prêt' }).count();
    const png = await Sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 26, g: 82, b: 118 } },
    })
      .png()
      .toBuffer();
    await page
      .getByLabel('Ajouter une image')
      .setInputFiles({ name: `couverture-happy-${runId}.png`, mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Uploader' }).click();
    await expect(page.locator('.kz-media-card', { hasText: 'Prêt' })).toHaveCount(before + 1, {
      timeout: 30_000,
    });

    // Alt posé immédiatement (requis à la publication) — le média devient
    // identifiable dans les pickers.
    const rows = await query<{ id: string }>(
      "select id from kreiz_media where alt_text = '' and status = 'ready' order by created_at desc limit 1",
    );
    const coverId = rows[0]!.id;
    const card = page.locator('.kz-media-card', { has: page.locator(`#alt-${coverId}`) });
    await card.locator('input[name="alt_text"]').fill(`Couverture parcours ${runId}`);
    await card.getByRole('button', { name: 'Enregistrer le texte alternatif' }).click();
    await expect(page).toHaveURL(/alt=1/);

    saveState({
      slug,
      entryId: '',
      coverId,
      bodyMediaId: coverId, // la même image sert de corps dans l'histoire
      contactEmail: '',
    });
  });

  test('2. article : rich text saisi, image insérée, couverture choisie — Save', async ({
    page,
  }) => {
    const state = readState();
    await login(page);
    await resetHookCaptures();

    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre', exact: true }).fill(`Le parcours complet ${runId}`);
    await page.getByLabel('Slug').fill(slug);
    await page.getByLabel('Accroche').fill('Accroche du parcours global de bout en bout.');
    await page.getByLabel('Auteur').fill('Rédactrice Kreiz');

    // Saisie riche réelle au clavier : un titre de section + un paragraphe
    // avec un mot en gras — le document canonique doit le porter.
    await page.getByLabel('Corps').click();
    await page.keyboard.type('Ce que le parcours prouve');
    await page.getByRole('button', { name: 'Titre de niveau 2' }).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Toutes les briques fonctionnent ');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b');
    await page.keyboard.type('ensemble');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b');
    await page.keyboard.type(', sans couture.');

    // Insertion d'une image de la médiathèque dans le corps + légende.
    await page.getByRole('button', { name: 'Insérer une image de la médiathèque' }).click();
    const dialog = page.locator('[data-role="richtext-picker"]');
    await expect(dialog).toBeVisible();
    await dialog
      .locator('[data-role="richtext-pick"]')
      .filter({ hasText: `Couverture parcours ${runId}` })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.locator('.kz-richtext-media__caption').fill('Illustration du parcours');

    // Couverture système depuis le picker du formulaire.
    await page
      .getByLabel('Image de couverture')
      .selectOption({ label: `Couverture parcours ${runId}` });

    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
    const entryId = entryIdFromUrl(page.url());
    saveState({ ...state, entryId });

    // Effets serveur : document canonique (heading, bold, mediaId), champ
    // système cover_media_id peuplé, statut brouillon.
    const rows = await query<{
      status: string;
      cover_media_id: string | null;
      data: { body: unknown };
    }>('select status, cover_media_id, data from kreiz_content_entries where id = $1', [entryId]);
    expect(rows[0]!.status).toBe('draft');
    expect(rows[0]!.cover_media_id).toBe(state.coverId);
    const serialized = JSON.stringify(rows[0]!.data.body);
    expect(serialized).toContain('"heading"');
    expect(serialized).toContain('"bold"');
    expect(serialized).toContain(state.coverId);
    expect(serialized).toContain('Illustration du parcours');
    // Jamais d'HTML ni d'URL stockés dans le corps — des références média.
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  test('3. publication : le site public rend rich text, couverture, SEO et beacon', async ({
    page,
  }) => {
    const state = readState();
    await login(page);

    await page.goto(`/admin/content/article/${state.entryId}`);
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/rebuild=ok&published=1$/);
    await expect(page.getByText('Contenu publié — reconstruction du site demandée')).toBeVisible();

    // Le rebuild a bien été demandé (serveur de hook local).
    const reasons = (await capturedHookRequests()).map((r) => String(r.body['reason'] ?? ''));
    expect(reasons).toContain('content.published');

    // Le site public sert la page complète : rich text rendu (h2, gras),
    // image du corps en figure, couverture responsive, head résolue, beacon.
    const html = await gotoPublicArticle(page, `/articles/${state.slug}`);
    expect(html).toContain('<h2>Ce que le parcours prouve</h2>');
    expect(html).toContain('<strong>ensemble</strong>');
    expect(html).toContain('Illustration du parcours');
    expect(html).toContain(`media/${state.coverId}/400`);
    expect(html).toContain(`<title>Le parcours complet ${runId} | Kreiz demo</title>`);
    expect(html).toContain(`<link rel="canonical" href="${siteUrl}/articles/${state.slug}" />`);
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('<script src="/api/analytics/beacon.js" defer></script>');
    expect(html).not.toContain('Tiptap');
    expect(html).not.toContain('tiptap');

    // La couverture est un <picture> responsive servi depuis la base publique.
    // La couverture est servie en <picture> : le fallback img porte une
    // variante du média (400/800 selon la largeur source — jamais d'upscale).
    await expect(page.locator('[data-kreiz-cover] img')).toHaveAttribute(
      'src',
      new RegExp(`media/${state.coverId}/\\d+\\.webp`),
    );
    const figure = page.locator('[data-kreiz-media]');
    await expect(figure).toBeVisible();
    await expect(figure.locator('figcaption')).toHaveText('Illustration du parcours');
  });

  test('4. le site est mesuré et indexé : analytics, sitemap, robots', async ({
    browser,
    request,
  }) => {
    const state = readState();
    // Fenêtre de rate limiting analytics propre (IP unique du run).
    await query("delete from kreiz_rate_limits where key like 'analytics:%'");

    // Un visiteur réel (UA non-bot) lit l'article publié.
    const context = await browser.newContext({ userAgent: REAL_BROWSER_UA });
    const visitor = await context.newPage();
    await gotoPublicArticle(visitor, `/articles/${state.slug}`);
    await context.close();

    // La page view est collectée pour CE chemin — privacy-first, sans PII.
    const rows = await waitForRows(
      `select path from kreiz_analytics_events
       where event_name = 'page_view' and path = $1`,
      [`/articles/${state.slug}`],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Le fichier beacon lui-même est servi (statique en production).
    const beacon = await request.get('/api/analytics/beacon.js');
    expect(beacon.status()).toBe(200);
    expect(await beacon.text()).toContain('kreiz.analytics.session');

    // Sitemap : la page publiée y est, à la base canonique déclarée.
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap).toContain(`<loc>${siteUrl}/articles/${state.slug}</loc>`);

    // Robots : convention de crawl — admin/api exclus, sitemap référencé.
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain(`${siteUrl}/sitemap.xml`);
  });

  test('5. un visiteur contacte : demande stockée, notifiée, visible admin, convertie', async ({
    page,
  }) => {
    const state = readState();
    const contactEmail = `e2e-contact-${state.slug}@example.test`;
    saveState({ ...state, contactEmail });

    // Soumission publique réelle (anti-spam satisfait : temps de remplissage).
    await page.goto('/contact');
    await page.waitForTimeout(3200);
    await page.getByLabel('Nom').fill('Visiteuse du parcours');
    await page.getByLabel('Email').fill(contactEmail);
    await page.getByLabel('Sujet').selectOption('question');
    await page.getByLabel('Message').fill('Bonjour, votre article complet m’a convaincue.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();
    await expect(page).toHaveURL(/\/contact\/merci$/);

    // La conversion analytics est enregistrée — sans aucune donnée du formulaire.
    const conversion = await waitForRows(
      `select metadata from kreiz_analytics_events
       where event_name = 'form_accepted' and metadata->>'form' = 'contact'
       and created_at > now() - interval '2 minutes'`,
      [],
    );
    expect(JSON.stringify(conversion).toLowerCase()).not.toContain(contactEmail);

    // La demande est visible dans la boîte admin de contact.
    await login(page);
    await page.goto('/admin/forms');
    await expect(page.getByRole('heading', { name: 'Boîte de contact', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Consulter' }).first().click();
    await expect(page.getByText('Visiteuse du parcours')).toBeVisible();
    await expect(page.getByText(contactEmail)).toBeVisible();

    // Le dashboard analytics rend la conversion du formulaire.
    await page.goto('/admin/analytics');
    const conversions = page.getByTestId('analytics-conversions');
    await expect(conversions).toBeVisible();
    const value = Number((await conversions.textContent())?.replace(/\s/g, '').replace(/\u202f/g, ''));
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
  });

  test('6. correction éditoriale : Save sans Publish — le public ne bouge pas', async ({
    page,
  }) => {
    const state = readState();
    await login(page);

    await page.goto(`/admin/content/article/${state.entryId}`);
    await page.getByLabel('Corps').fill(
      'Toutes les briques fonctionnent ensemble, sans couture — version corrigée.',
    );
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(/saved=1$/);
    await expect(page.getByText('Modifications enregistrées — non publiées')).toBeVisible();

    // La base sépare les projections : courant corrigé, public figé.
    const rows = await query<{ data: { body: unknown }; published_data: { body: unknown } }>(
      'select data, published_data from kreiz_content_entries where id = $1',
      [state.entryId],
    );
    expect(bodyText(rows[0]!.data.body)).toContain('version corrigée');
    expect(bodyText(rows[0]!.published_data.body)).not.toContain('version corrigée');

    // La preview (SSR, état courant) montre déjà la correction…
    await page.goto(`/admin/preview/${state.entryId}`);
    await expect(page.getByText('version corrigée')).toBeVisible();

    // …mais le site public reste sur la version publiée.
    const publicHtml = await gotoPublicArticle(page, `/articles/${state.slug}`);
    expect(publicHtml).not.toContain('version corrigée');
    expect(publicHtml).toContain('Ce que le parcours prouve');
  });

  test('7. republier : le site public suit, rebuild redemandé', async ({ page }) => {
    const state = readState();
    await login(page);
    await resetHookCaptures();

    await page.goto(`/admin/content/article/${state.entryId}`);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/rebuild=ok&published=1$/);

    const reasons = (await capturedHookRequests()).map((r) => String(r.body['reason'] ?? ''));
    expect(reasons).toContain('content.published');

    // Le public a basculé sur la version corrigée.
    const html = await gotoPublicArticle(page, `/articles/${state.slug}`);
    expect(html).toContain('version corrigée');
  });
});
