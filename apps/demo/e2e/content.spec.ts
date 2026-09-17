import { expect, type Page, test } from '@playwright/test';
import { query } from './db';
import { bodyText } from './richtext';

/**
 * Parcours critiques du slice 3 — moteur de contenu (mission §35). Tout le
 * flux utilisateur passe par le navigateur (formulaires progressifs) ; la
 * base n'est touchée que pour vérifier les effets serveur (persistance,
 * soft delete, audit, absence de données invalides).
 *
 * Prérequis : les comptes admin sont créés par le CLI dans global-setup
 * (comme au slice 2) ; les contenus le sont via l'UI et supprimés par le
 * nettoyage global (0 ligne résiduelle).
 */

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function createArticleDraft(
  page: Page,
  values: {
    title: string;
    excerpt: string;
    body: string;
    author: string;
    slug?: string;
  },
): Promise<void> {
  await page.goto('/admin/content/article/new');
  await page.getByRole('textbox', { name: 'Titre', exact: true }).fill(values.title);
  if (values.slug) await page.getByLabel('Slug').fill(values.slug);
  await page.getByLabel('Accroche').fill(values.excerpt);
  await page.getByLabel('Corps').fill(values.body);
  await page.getByLabel('Auteur').fill(values.author);
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
}

function entryIdFromUrl(url: string): string {
  return url.split('/').at(-1) ?? '';
}

test.describe('back-office — moteur de contenu', () => {
  test('navigation : login → /admin → Articles (nav générée depuis le registre) → listing', async ({
    page,
  }) => {
    await login(page);

    // La navigation Contenu est dynamique : les types déclarés par le demo.
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByRole('link', { name: 'Articles' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Guides' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Réalisations' })).toBeVisible();

    await nav.getByRole('link', { name: 'Articles' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article$/);
    await expect(page.getByRole('heading', { name: 'Articles' })).toBeVisible();
  });

  test('création d’un article : formulaire généré → Save draft → retour édition', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article/new');

    const title = 'Article E2E création';
    await page.getByRole('textbox', { name: 'Titre', exact: true }).fill(title);
    await page.getByLabel('Accroche').fill('Accroche du test E2E.');
    await page.getByLabel('Corps').fill('Paragraphe unique du corps E2E.');
    await page.getByLabel('Auteur').fill('Auteure E2E');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();

    // Retour sur la page d'édition du brouillon créé.
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('textbox', { name: 'Titre', exact: true })).toHaveValue(title);
    await expect(page.getByLabel('Accroche')).toHaveValue('Accroche du test E2E.');
    await expect(page.getByLabel('Auteur')).toHaveValue('Auteure E2E');

    // Slug auto généré depuis le titre (mission §11).
    await expect(page.getByLabel('Slug')).toHaveValue('article-e2e-creation');

    // Persistance vérifiée en base : statut draft, namespace imposé serveur.
    const id = entryIdFromUrl(page.url());
    const rows = await query<{
      content_type: string;
      route_namespace: string;
      status: string;
      slug: string;
    }>('select content_type, route_namespace, status, slug from kreiz_content_entries where id = $1', [
      id,
    ]);
    expect(rows[0]).toMatchObject({
      content_type: 'article',
      route_namespace: 'articles',
      status: 'draft',
      slug: 'article-e2e-creation',
    });
  });

  test('validation : champ requis absent → erreur visible, aucune donnée invalide persistée', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article/new');

    await page.getByRole('textbox', { name: 'Titre', exact: true }).fill('Article E2E invalide');
    // Accroche (requis) laissée vide.
    await page.getByLabel('Corps').fill('Corps présent.');
    await page.getByLabel('Auteur').fill('Auteure E2E');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();

    // Re-rendu du formulaire avec erreurs de champ, valeurs préservées.
    await expect(page).toHaveURL(/\/admin\/content\/article\/new$/);
    await expect(page.getByText('Ce champ est requis.').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Titre', exact: true })).toHaveValue('Article E2E invalide');

    const rows = await query<{ count: string }>(
      'select count(*)::text as count from kreiz_content_entries where title = $1',
      ['Article E2E invalide'],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  test('slug : manuel modifié et sauvegardé ; collision manuelle → erreur ; auto → suffixage', async ({
    page,
  }) => {
    await login(page);

    // Slug saisi manuellement à la création, puis conservé.
    await createArticleDraft(page, {
      title: 'Article E2E slug',
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
      slug: 'article-e2e-slug-choisi',
    });
    const firstId = entryIdFromUrl(page.url());
    await expect(page.getByLabel('Slug')).toHaveValue('article-e2e-slug-choisi');

    // Collision manuelle à la création : erreur explicite (jamais suffixée
    // en silence — le choix d'un admin ne se modifie pas tout seul).
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre', exact: true }).fill('Article E2E collision');
    await page.getByLabel('Slug').fill('article-e2e-slug-choisi');
    await page.getByLabel('Accroche').fill('Accroche.');
    await page.getByLabel('Corps').fill('Corps.');
    await page.getByLabel('Auteur').fill('Auteure');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/new$/);
    await expect(page.getByText(/Ce slug est déjà utilisé/)).toBeVisible();

    // Slug généré en collision : suffixage automatique.
    await createArticleDraft(page, {
      title: 'Article E2E suffixé',
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
    });
    const suffixedSlug = await page.getByLabel('Slug').inputValue();
    expect(suffixedSlug).toBe('article-e2e-suffixe');

    // Collision à l'édition : modifier le slug vers un slug pris → erreur.
    await page.goto(`/admin/content/article/${firstId}`);
    await page.getByLabel('Slug').fill(suffixedSlug);
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page.getByText(/Ce slug est déjà utilisé/)).toBeVisible();
  });

  test('édition : modifier le contenu → sauvegarder → valeurs retrouvées (bandeau)', async ({
    page,
  }) => {
    await login(page);
    await createArticleDraft(page, {
      title: 'Article E2E édition',
      excerpt: 'Accroche initiale.',
      body: 'Corps initial.',
      author: 'Auteure',
    });
    const id = entryIdFromUrl(page.url());

    await page.getByLabel('Corps').fill('Corps modifié par E2E.');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();

    // Redirect 303 + bandeau de confirmation, valeurs fraîches re-rendues.
    await expect(page).toHaveURL(new RegExp(`/admin/content/article/${id}\\?saved=1$`));
    await expect(page.getByText('Brouillon enregistré.')).toBeVisible();
    // L'éditeur contenteditable expose son texte, pas de `.value`.
    await expect(page.getByLabel('Corps')).toContainText('Corps modifié par E2E.');

    const rows = await query<{ data: { body: unknown } }>(
      'select data from kreiz_content_entries where id = $1',
      [id],
    );
    // Le corps est stocké comme document canonique (slice 6), pas une chaîne.
    expect(bodyText(rows[0]!.data.body)).toBe('Corps modifié par E2E.');
    expect(rows[0]!.data.body).toMatchObject({ version: 1, type: 'doc' });
  });

  test('preview : brouillon rendu avec le vrai template du Project, authentifiée, noindex', async ({
    page,
  }) => {
    await login(page);
    await createArticleDraft(page, {
      title: 'Article E2E preview',
      excerpt: 'Accroche preview.',
      body: 'Corps preview.',
      author: 'Auteure Preview',
    });
    const id = entryIdFromUrl(page.url());

    await page.getByRole('link', { name: 'Preview' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/preview/${id}$`));

    // Vrai template du Project (ArticleContent.astro) : marquages propres au
    // template (header, mention brouillon, signature du footer) + données
    // structurées rendues.
    await expect(page.getByText('brouillon (preview)')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Article E2E preview' })).toBeVisible();
    await expect(page.getByText('Par Auteure Preview')).toBeVisible();
    await expect(
      page.getByText('Kreiz, application de démonstration'),
    ).toBeVisible();

    // noindex sur la preview (mission §20).
    const previewResponse = await page.request.get(`/admin/preview/${id}`);
    expect(previewResponse.status()).toBe(200);
    expect(previewResponse.headers()['x-robots-tag']).toContain('noindex');

    // La preview sans session est refusée (redirection login) — le cookie
    // ne quitte jamais Path=/admin.
    await page.context().clearCookies();
    const unauthenticated = await page.request.get(`/admin/preview/${id}`, {
      maxRedirects: 0,
    });
    expect([302, 303]).toContain(unauthenticated.status());
    expect(unauthenticated.headers().location).toBe('/admin/login');
  });

  test('suppression : soft delete → absent du listing, slug libéré, audit', async ({ page }) => {
    await login(page);
    await createArticleDraft(page, {
      title: 'Article E2E suppression',
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
    });
    const id = entryIdFromUrl(page.url());

    // Suppression depuis la page d'édition.
    await page.getByRole('button', { name: 'Supprimer' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article$/);
    await expect(page.getByText('Article E2E suppression')).toHaveCount(0);

    // Effet serveur : soft delete (deleted_at non nul), ligne conservée.
    const rows = await query<{ deleted_at: string | null; slug: string }>(
      'select deleted_at::text as deleted_at, slug from kreiz_content_entries where id = $1',
      [id],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(rows[0]!.slug).toBe('article-e2e-suppression');

    // Audit content.deleted avec le vrai acteur.
    const audit = await query<{ action: string }>(
      `select action from kreiz_admin_audit_log
       where entity_id = $1 and action = 'content.deleted'`,
      [id],
    );
    expect(audit).toHaveLength(1);

    // Le slug libéré est réutilisable.
    await createArticleDraft(page, {
      title: 'Article E2E suppression',
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
    });
    await expect(page.getByLabel('Slug')).toHaveValue('article-e2e-suppression');
  });

  test('isolation des types : un Article n’est pas éditable via une route Guide', async ({
    page,
  }) => {
    await login(page);
    await createArticleDraft(page, {
      title: 'Article E2E isolation',
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
    });
    const id = entryIdFromUrl(page.url());

    // Mauvais type dans l'URL : 404 sans détail, contenu non édité.
    const wrongType = await page.request.get(`/admin/content/guide/${id}`);
    expect(wrongType.status()).toBe(404);

    await page.goto(`/admin/content/guide/${id}`);
    await expect(page.getByText('Contenu introuvable')).toBeVisible();
  });
});
