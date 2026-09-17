import { expect, type Page, test } from '@playwright/test';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Sharp from 'sharp';
import { query } from './db';

/**
 * Parcours critiques du slice 9 — SEO (mission §40). Le head public est
 * résolu par le Core (`resolveContentSeo` + `seoHeadTags` dans les
 * templates du Project), le sitemap/robots sont des fichiers du Core ; la
 * base n'est touchée que pour vérifier les effets serveur (snapshots SEO,
 * redirections, ids média) et récupérer des identifiants.
 *
 * Prérequis : admin créé par le CLI (global-setup) ; serveur dev avec
 * `KREIZ_SITE_URL=http://127.0.0.1:4321` — la base canonique vient toujours
 * d'une config fiable, jamais d'un Host.
 *
 * État partagé entre tests : fichier (comme media.spec) — un redémarrage de
 * worker Playwright réimporte le module, l'état module seul n'est pas fiable.
 *
 * Note dev server : Astro mémoïse `getStaticPaths` par route après la
 * première requête — une page publiée **après** le réchauffement de
 * `/articles/[slug]` renverrait 404 en dev (comportement dev uniquement ;
 * en production le build recalcule tout). Les visites publiques passent
 * donc par `gotoPublicArticle`, qui invalide le module de route (touch) et
 * retente — workaround dev documenté, aucun impact production.
 */

const E2E_ROOT = import.meta.dirname;
const STATE_FILE = join(E2E_ROOT, '.seo-state.json');
type SeoState = { slug: string; entryId: string; mediaId: string; titleA: string; seoTitleB: string };

function saveState(state: SeoState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function readState(): SeoState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SeoState;
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
  // Texte brut de la réponse : les assertions portent le HTML exact servi
  // (page.content() normaliserait les balises auto-fermantes).
  return (await response?.text()) ?? '';
}

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const publicBaseUrl = process.env.E2E_STORAGE_PUBLIC_BASE_URL ?? '';
const siteUrl = 'http://127.0.0.1:4321';
const runId = Math.random().toString(36).slice(2, 8);

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function createArticleDraft(
  page: Page,
  values: { title: string; excerpt: string; body: string; author: string; slug: string },
): Promise<string> {
  await page.goto('/admin/content/article/new');
  await page.getByRole('textbox', { name: 'Titre', exact: true }).fill(values.title);
  await page.getByLabel('Slug').fill(values.slug);
  await page.getByLabel('Accroche').fill(values.excerpt);
  await page.getByLabel('Corps').fill(values.body);
  await page.getByLabel('Auteur').fill(values.author);
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
  return page.url().split('?')[0]!.split('/').at(-1)!;
}

async function saveSeo(page: Page, values: { seoTitle?: string; noindex?: boolean }): Promise<void> {
  if (values.seoTitle !== undefined) {
    await page.getByLabel('Titre SEO').fill(values.seoTitle);
  }
  if (values.noindex !== undefined) {
    await page.getByLabel('Exclure des moteurs de recherche (noindex)').setChecked(values.noindex);
  }
  await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
  await expect(page).toHaveURL(/saved=1$/);
}

test.describe('SEO public — head, sitemap, robots (slice 9)', () => {
  test('publication → head résolue : title, description, canonical, OG, JSON-LD', async ({
    page,
  }) => {
    await login(page);
    const slug = `e2e-seo-${runId}`;
    const entryId = await createArticleDraft(page, {
      title: `Article SEO E2E ${runId}`,
      excerpt: 'Accroche SEO de démonstration.',
      body: 'Corps du texte publié.',
      author: 'Auteure SEO',
      slug,
    });
    saveState({ slug, entryId, mediaId: '', titleA: `Article SEO E2E ${runId}`, seoTitleB: `Titre SEO B ${runId}` });
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1$/);

    const html = await gotoPublicArticle(page, `/articles/${slug}`);
    expect(html).toContain(`<title>Article SEO E2E ${runId} | Kreiz demo</title>`);
    // Description dérivée de l'accroche (champ du Project).
    expect(html).toContain('<meta name="description" content="Accroche SEO de démonstration." />');
    // Canonical : base fiable (KREIZ_SITE_URL) + slug publié — pas un Host.
    expect(html).toContain(`<link rel="canonical" href="${siteUrl}/articles/${slug}" />`);
    expect(html).toContain('<meta name="robots" content="index, follow" />');
    expect(html).toContain('<meta name="referrer" content="strict-origin-when-cross-origin" />');
    // Open Graph.
    expect(html).toContain(`<meta property="og:url" content="${siteUrl}/articles/${slug}" />`);
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('<meta property="og:site_name" content="Kreiz demo" />');
    expect(html).toContain('<meta property="og:locale" content="fr-FR" />');
    // Pas d'image OG tant que rien n'en référencé et sans couverture : ni
    // og:image, ni card large — et pas de balise vide pour autant.
    expect(html).not.toContain('og:image');
    // Twitter : card + handle ; le reste retombe sur l'OG (pas de doublon).
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).not.toContain('twitter:title');
    // JSON-LD : BlogPosting construit par le builder typé du Core.
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain(`"headline":"Article SEO E2E ${runId}"`);
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  test('Save ≠ Publish sur le SEO : le public ne bouge qu’au Publish', async ({ page }) => {
    const { slug, entryId, titleA, seoTitleB } = readState();
    await login(page);
    await page.goto(`/admin/content/article/${entryId}`);
    await saveSeo(page, { seoTitle: seoTitleB });

    // Le public reste sur le title A.
    let publicHtml = await gotoPublicArticle(page, `/articles/${slug}`);
    expect(publicHtml).toContain(`<title>${titleA} | Kreiz demo</title>`);
    expect(publicHtml).not.toContain(seoTitleB);

    // Publish : le public bascule en B.
    await page.goto(`/admin/content/article/${entryId}`);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1$/);
    publicHtml = await gotoPublicArticle(page, `/articles/${slug}`);
    expect(publicHtml).toContain(`<title>${seoTitleB} | Kreiz demo</title>`);
  });

  test('image OG via la médiathèque : og:image + dimensions + card large', async ({ page }) => {
    const { slug, entryId } = readState();
    await login(page);
    // Upload via l'UI → ready (pipeline slice 5 complet, serveur S3 local).
    await page.goto('/admin/media');
    const before = await page.locator('.kz-media-card', { hasText: 'Prêt' }).count();
    const png = await Sharp({
      create: { width: 800, height: 450, channels: 3, background: { r: 30, g: 110, b: 90 } },
    })
      .png()
      .toBuffer();
    await page
      .getByLabel('Ajouter une image')
      .setInputFiles({ name: `e2e-og-${runId}.png`, mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: 'Uploader' }).click();
    await expect(page.locator('.kz-media-card', { hasText: 'Prêt' })).toHaveCount(before + 1, {
      timeout: 30_000,
    });
    const alt = `og-e2e-${runId}`;
    const card = page.locator('.kz-media-card', { hasText: 'Prêt' }).last();
    await card.locator('input[name="alt_text"]').fill(alt);
    await card.getByRole('button', { name: 'Enregistrer le texte alternatif' }).click();
    await expect(page).toHaveURL(/alt=1/);
    const mediaRows = await query<{ id: string }>('select id from kreiz_media where alt_text = $1', [alt]);
    const mediaId = mediaRows[0]!.id;
    saveState({ slug, entryId, mediaId, titleA: `Article SEO E2E ${runId}`, seoTitleB: `Titre SEO B ${runId}` });

    // Sélection dans le picker OG du formulaire d'édition (retry : une
    // invalidation Vite peut avorter une navigation en dev).
    try {
      await page.goto(`/admin/content/article/${entryId}`);
    } catch {
      await page.waitForTimeout(2000);
      await page.goto(`/admin/content/article/${entryId}`);
    }
    await page.getByLabel('Image Open Graph').selectOption(mediaId);
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(/saved=1$/);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1$/);

    const html = await gotoPublicArticle(page, `/articles/${slug}`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toMatch(
      new RegExp(`<meta property="og:image" content="${publicBaseUrl}/media/${mediaId}/\\d+\\.webp" />`),
    );
    expect(html).toMatch(/<meta property="og:image:width" content="\d+" \/>/);
    expect(html).toMatch(/<meta property="og:image:height" content="\d+" \/>/);
    expect(html).toContain(`<meta property="og:image:alt" content="${alt}" />`);
  });

  test('sitemap : publiés indexables présents, base canonique déclarée, chemins statiques', async ({
    request,
  }) => {
    const { slug } = readState();
    const response = await request.get('/sitemap.xml');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toContain('application/xml');
    const xml = (await response?.text()) ?? '';
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${siteUrl}/articles/${slug}</loc>`);
    expect(xml).toContain(`<lastmod>`);
    expect(xml).toContain(`<loc>${siteUrl}/</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/contact</loc>`);
  });

  test('brouillon jamais publié : absent du sitemap', async ({ request, page }) => {
    await login(page);
    const draftSlug = `e2e-seo-draft-${runId}`;
    await createArticleDraft(page, {
      title: `Brouillon SEO E2E ${runId}`,
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
      slug: draftSlug,
    });
    const xml = await (await request.get('/sitemap.xml'))?.text();
    expect(xml).not.toContain(draftSlug);
  });

  test('noindex publié : meta robots + exclusion du sitemap', async ({ request, page }) => {
    await login(page);
    const noindexSlug = `e2e-seo-noindex-${runId}`;
    const noindexId = await createArticleDraft(page, {
      title: `Noindex SEO E2E ${runId}`,
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
      slug: noindexSlug,
    });
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1$/);

    await page.goto(`/admin/content/article/${noindexId}`);
    await saveSeo(page, { noindex: true });
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1$/);

    const html = await gotoPublicArticle(page, `/articles/${noindexSlug}`);
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    // Pas de canonical ni og:url sur une page non indexable.
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');

    const xml = await (await request.get('/sitemap.xml'))?.text();
    expect(xml).not.toContain(noindexSlug);
  });

  test('drift de slug : redirection en base, canonical et sitemap sur la nouvelle URL', async ({
    request,
    page,
  }) => {
    await login(page);
    const oldSlug = `e2e-seo-drift-${runId}`;
    const driftId = await createArticleDraft(page, {
      title: `Drift SEO E2E ${runId}`,
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
      slug: oldSlug,
    });
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1$/);

    const newSlug = `${oldSlug}-b`;
    await page.goto(`/admin/content/article/${driftId}`);
    await page.getByLabel('Slug').fill(newSlug);
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(/saved=1$/);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1$/);

    // Redirection 301 enregistrée en base (le dev server ne la sert pas —
    // matérialisée au build par l'adapter, slice 4).
    const redirects = await query<{ from_path: string; to_path: string }>(
      'select from_path, to_path from kreiz_redirects where from_path = $1',
      [`/articles/${oldSlug}`],
    );
    expect(redirects[0]).toMatchObject({
      from_path: `/articles/${oldSlug}`,
      to_path: `/articles/${newSlug}`,
    });

    // Canonical nouvelle URL, jamais l'ancienne.
    const html = await gotoPublicArticle(page, `/articles/${newSlug}`);
    expect(html).toContain(`<link rel="canonical" href="${siteUrl}/articles/${newSlug}" />`);
    expect(html).not.toContain(`href="${siteUrl}/articles/${oldSlug}"`);

    const xml = await (await request.get('/sitemap.xml'))?.text();
    expect(xml).toContain(`<loc>${siteUrl}/articles/${newSlug}</loc>`);
    expect(xml).not.toContain(`<loc>${siteUrl}/articles/${oldSlug}</loc>`);
  });

  test('robots.txt et preview noindex ; head admin jamais indexable', async ({ request, page }) => {
    const { entryId } = readState();
    const robots = await (await request.get('/robots.txt'))?.text();
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /api');
    expect(robots).toContain(`Sitemap: ${siteUrl}/sitemap.xml`);

    await login(page);
    // Preview : même template, head forcée noindex par le Core.
    await page.goto(`/admin/preview/${entryId}`);
    const html = await page.content();
    expect(html).toContain('<meta name="robots" content="noindex, follow"');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
  });
});
