import { expect, type Page, test } from '@playwright/test';
import { query } from './db';
import { bodyText } from './richtext';
import {
  capturedHookRequests,
  resetHookCaptures,
  setHookFailMode,
} from './rebuild-hook-server';

/**
 * Parcours critiques du slice 4 — publication, Save != Publish, redirections
 * de slug, dépublication, échec de rebuild (mission §45). Tout le flux
 * utilisateur passe par le navigateur ; la base n'est touchée que pour
 * vérifier les effets serveur (statuts, snapshots publics, redirections,
 * audit) et le **serveur de hook local** prouve que chaque action publie
 * bien une demande de rebuild — sans jamais appeler un vrai Vercel.
 *
 * Prérequis : admin créé par le CLI (global-setup) ; le serveur dev tourne
 * avec `KREIZ_REBUILD_DEPLOY_HOOK_URL` → serveur local contrôlé.
 */

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const runId = Date.now().toString(36);

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function createArticleDraft(
  page: Page,
  values: { title: string; excerpt: string; body: string; author: string; slug?: string },
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
  return url.split('?')[0]!.split('/').at(-1) ?? '';
}

async function hookReasons(): Promise<string[]> {
  const captured = await capturedHookRequests();
  return captured.map((request) => String(request.body['reason'] ?? ''));
}

test.describe('back-office — publication et rebuild (slice 4)', () => {
  test('Publish : draft → publié, snapshots figés, audit, rebuild demandé au hook local', async ({
    page,
  }) => {
    await resetHookCaptures();
    await login(page);
    await createArticleDraft(page, {
      title: `Article E2E publication ${runId}`,
      excerpt: 'Accroche publication.',
      body: 'Corps version 1.',
      author: 'Auteure Pub',
      slug: `e2e-pub-${runId}`,
    });
    const id = entryIdFromUrl(page.url());

    // Écran d'édition d'un brouillon : état explicite + bouton Publier.
    await expect(page.getByText("n'est pas encore visible sur le site public")).toBeVisible();
    await page.getByRole('button', { name: 'Publier', exact: true }).click();

    // Retour édition avec le bandeau de succès rebuild.
    await expect(page).toHaveURL(new RegExp(`/admin/content/article/${id}\\?rebuild=ok&published=1$`));
    await expect(page.getByText('Contenu publié — reconstruction du site demandée')).toBeVisible();
    await expect(page.getByText('Publié', { exact: true })).toBeVisible();

    // Effets serveur : statut, snapshots publics, published_at.
    const rows = await query<{
      status: string;
      published_at: string | null;
      published_slug: string | null;
      published_title: string | null;
      published_data: { body?: unknown } | null;
      slug: string;
    }>(
      `select status, published_at::text, published_slug, published_title, published_data, slug
       from kreiz_content_entries where id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      status: 'published',
      published_slug: `e2e-pub-${runId}`,
      published_title: `Article E2E publication ${runId}`,
    });
    expect(rows[0]!.published_at).not.toBeNull();
    // Le corps publié est un document canonique portant le texte (slice 6).
    expect(bodyText(rows[0]!.published_data?.body)).toBe('Corps version 1.');

    // Audit content.published avec le vrai acteur.
    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      `select action, metadata from kreiz_admin_audit_log where entity_id = $1 and action = 'content.published'`,
      [id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ slug: `e2e-pub-${runId}` });

    // Le deploy hook local a reçu la demande de reconstruction.
    expect(await hookReasons()).toContain('content.published');
  });

  test('Save != Publish : Save sur un publié ne touche pas la version publique ; Preview montre le courant', async ({
    page,
  }) => {
    await login(page);
    // Reprise du contenu publié du test précédent via le listing.
    await page.goto('/admin/content/article');
    const link = page.getByRole('link', { name: `Article E2E publication ${runId}` });
    await link.click();
    const id = entryIdFromUrl(page.url());

    // Aucun indicateur « non publié » juste après publication.
    await expect(page.getByText('Modifications non publiées')).toHaveCount(0);

    // Save éditorial sur le contenu publié — le libellé ne doit jamais
    // laisser croire que le site public change (mission §28).
    await page.getByLabel('Corps').fill('Corps version 2 — non publié.');
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/content/article/${id}\\?saved=1$`));
    await expect(page.getByText('Modifications enregistrées — non publiées')).toBeVisible();

    // La base sépare les deux projections : courant V2, public V1 —
    // preuve que le prochain build n'embarquerait pas le Save.
    const rows = await query<{ data: { body: unknown }; published_data: { body: unknown } }>(
      'select data, published_data from kreiz_content_entries where id = $1',
      [id],
    );
    // Save != Publish sur le corps : courant = V2, public figé = V1 (slice 6).
    expect(bodyText(rows[0]!.data.body)).toBe('Corps version 2 — non publié.');
    expect(bodyText(rows[0]!.published_data.body)).toBe('Corps version 1.');

    // Le listing affiche l'indicateur de modifications non publiées (mission §29).
    await page.goto('/admin/content/article');
    await expect(
      page.getByTitle(
        "Enregistré mais non publié — la version publique reste en ligne jusqu'à la publication.",
      ),
    ).toBeVisible();

    // La preview rend l'état éditorial COURANT (mission §30).
    await page.goto(`/admin/preview/${id}`);
    await expect(page.getByText('Corps version 2 — non publié.')).toBeVisible();

    // Publication des modifications → snapshot mis à jour + rebuild.
    await page.goto(`/admin/content/article/${id}`);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?rebuild=ok&published=1$`));
    const updated = await query<{ published_data: { body: unknown } }>(
      'select published_data from kreiz_content_entries where id = $1',
      [id],
    );
    expect(bodyText(updated[0]!.published_data.body)).toBe('Corps version 2 — non publié.');
    expect(await hookReasons()).toContain('content.published');
  });

  test('changement de slug publié → redirection 301 enregistrée, ownership posé', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article');
    await page.getByRole('link', { name: `Article E2E publication ${runId}` }).click();
    const id = entryIdFromUrl(page.url());

    await page.getByLabel('Slug').fill(`e2e-pub-${runId}-b`);
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    // L'écran signale l'écart entre l'adresse publique et le slug courant.
    await expect(page.getByText('Modifications non publiées')).toBeVisible();

    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?rebuild=ok&published=1$`));

    // La redirection est en base : ancien chemin public → nouveau, 301.
    const redirects = await query<{ from_path: string; to_path: string; content_entry_id: string | null }>(
      'select from_path, to_path, content_entry_id from kreiz_redirects where from_path = $1',
      [`/articles/e2e-pub-${runId}`],
    );
    expect(redirects[0]).toMatchObject({
      from_path: `/articles/e2e-pub-${runId}`,
      to_path: `/articles/e2e-pub-${runId}-b`,
      content_entry_id: id,
    });

    // Le snapshot public suit le nouveau slug.
    const rows = await query<{ published_slug: string }>(
      'select published_slug from kreiz_content_entries where id = $1',
      [id],
    );
    expect(rows[0]!.published_slug).toBe(`e2e-pub-${runId}-b`);
  });

  test('Unpublish : retour au draft, historique conservé, audit, rebuild demandé', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article');
    await page.getByRole('link', { name: `Article E2E publication ${runId}` }).click();
    const id = entryIdFromUrl(page.url());

    await page.getByRole('button', { name: 'Dépublier' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?unpublished=1&rebuild=ok$`));
    await expect(page.getByText('Contenu dépublié — la page publique sera retirée')).toBeVisible();

    const rows = await query<{
      status: string;
      published_at: string | null;
      published_slug: string | null;
    }>(
      'select status, published_at::text, published_slug from kreiz_content_entries where id = $1',
      [id],
    );
    // Retour au draft ; le contenu et l'historique public sont conservés.
    expect(rows[0]!.status).toBe('draft');
    expect(rows[0]!.published_at).not.toBeNull();
    expect(rows[0]!.published_slug).toBe(`e2e-pub-${runId}-b`);

    const audit = await query<{ action: string }>(
      `select action from kreiz_admin_audit_log where entity_id = $1 and action = 'content.unpublished'`,
      [id],
    );
    expect(audit).toHaveLength(1);
    expect(await hookReasons()).toContain('content.unpublished');
  });

  test('échec du rebuild : message clair, DB cohérente, aucun secret exposé, retry possible', async ({
    page,
  }) => {
    await setHookFailMode(true);
    try {
      await login(page);
      await createArticleDraft(page, {
        title: `Article E2E rebuild failure ${runId}`,
        excerpt: 'Accroche.',
        body: 'Corps.',
        author: 'Auteure',
        slug: `e2e-pub-fail-${runId}`,
      });
      const id = entryIdFromUrl(page.url());

      await page.getByRole('button', { name: 'Publier', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`\\?rebuild=failed&published=1$`));
      await expect(
        page.getByText('la reconstruction a échoué : le site public reste inchangé'),
      ).toBeVisible();

      // La DB reste dans son état éditorial publié (mission §11) —
      // le dernier site valide n'est pas détruit par l'échec du trigger.
      const rows = await query<{ status: string; published_slug: string | null }>(
        'select status, published_slug from kreiz_content_entries where id = $1',
        [id],
      );
      expect(rows[0]!.status).toBe('published');
      expect(rows[0]!.published_slug).toBe(`e2e-pub-fail-${runId}`);

      // L'échec est audité, sans l'URL du hook ni la réponse du provider.
      const audit = await query<{ metadata: Record<string, unknown> }>(
        `select metadata from kreiz_admin_audit_log where entity_type = 'site' and action = 'site.rebuild_failed'`,
      );
      expect(audit.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(audit);
      expect(serialized).not.toContain('127.0.0.1:43990');

      // Aucun secret dans le HTML rendu (mission §49).
      const html = await page.content();
      expect(html).not.toContain('127.0.0.1:43990');
      expect(html).not.toContain('/hook');

      // Bouton de reprise : le hook redevient sain, la relance réussit.
      const retry = page.getByRole('button', { name: 'Relancer le déploiement' });
      await expect(retry).toBeVisible();
      await setHookFailMode(false);
      await retry.click();
      await expect(page).toHaveURL(new RegExp(`\\?rebuild=ok$`));
      await expect(page.getByText('Déploiement relancé — reconstruction du site demandée')).toBeVisible();
      expect(await hookReasons()).toContain('manual');
    } finally {
      await setHookFailMode(false);
    }
  });

  test('rebuild manuel depuis le dashboard : même port, audit site.rebuild_requested', async ({
    page,
  }) => {
    await resetHookCaptures();
    // Anti-tempête (revue sécurité finale) : le rebuild manuel est plafonné à
    // un par minute — la spec précédente vient d'en déclencher un, on purge le
    // compteur global pour rendre ce test déterministe.
    await query(`delete from kreiz_rate_limits where key like 'kreiz:rebuild-manual%'`);
    await login(page);
    // Le dashboard expose l'état du moteur de rebuild configuré.
    await expect(page.getByText('automatique (deploy hook Vercel)')).toBeVisible();
    await page.getByRole('button', { name: 'Reconstruire le site' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin\\?rebuild=ok$`));
    await expect(page.getByText('Reconstruction du site demandée')).toBeVisible();

    const reasons = await hookReasons();
    expect(reasons).toEqual(['manual']);

    const audit = await query<{ action: string; metadata: Record<string, unknown> }>(
      `select action, metadata from kreiz_admin_audit_log where action = 'site.rebuild_requested'`,
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.at(-1)!.metadata).toMatchObject({ reason: 'manual', source: 'admin' });
  });

  test('un changement de slug sur un simple draft ne crée jamais de redirect (mission §18)', async ({
    page,
  }) => {
    await login(page);
    await createArticleDraft(page, {
      title: `Article E2E sans redirect ${runId}`,
      excerpt: 'Accroche.',
      body: 'Corps.',
      author: 'Auteure',
      slug: `e2e-noredirect-${runId}-a`,
    });
    const id = entryIdFromUrl(page.url());

    await page.getByLabel('Slug').fill(`e2e-noredirect-${runId}-b`);
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(new RegExp(`\\?saved=1$`));

    const redirects = await query<{ from_path: string }>(
      'select from_path from kreiz_redirects where from_path like $1',
      [`/articles/e2e-noredirect-${runId}%`],
    );
    expect(redirects).toHaveLength(0);
    // Le brouillon reste un brouillon — aucune publication n'a eu lieu.
    const rows = await query<{ status: string }>(
      'select status from kreiz_content_entries where id = $1',
      [id],
    );
    expect(rows[0]!.status).toBe('draft');
  });

  test('la mutation publish sans CSRF est refusée (403), session intacte', async ({ page }) => {
    await login(page);
    await page.goto('/admin/content/article');
    await page.getByRole('link', { name: `Article E2E sans redirect ${runId}` }).click();
    const id = entryIdFromUrl(page.url());

    const response = await page.request.post(`/admin/content/article/${id}/publish`, {
      form: { csrf_token: 'valeur-falsifiée' },
    });
    expect(response.status()).toBe(403);

    // La page d'édition reste accessible : la session n'a pas été touchée.
    await page.goto(`/admin/content/article/${id}`);
    await expect(page.getByRole('textbox', { name: 'Titre', exact: true })).toBeVisible();
    // Rien n'a été publié.
    const rows = await query<{ status: string }>(
      'select status from kreiz_content_entries where id = $1',
      [id],
    );
    expect(rows[0]!.status).toBe('draft');
  });
});
