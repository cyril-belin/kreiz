import { expect, type Page, test } from '@playwright/test';
import Sharp from 'sharp';
import { query } from './db';
import { bodyText, editorDocument } from './richtext';

/**
 * Parcours critiques du slice 6 — éditeur riche Tiptap. Le navigateur exécute
 * l'éditeur réel (bundle admin) ; la base n'est touchée que pour vérifier les
 * effets serveur (document canonique stocké, snapshot Save ≠ Publish, refus de
 * publication) et poser des états d'infrastructure (média non prêt).
 *
 * Scénarios (mission §35) : saisie riche + persistence, Save ≠ Publish sur le
 * corps, média ready inséré via le picker, refus d'un média non ready, lien,
 * collage normalisé, restauration après reload.
 */

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const runId = `rt${Date.now().toString(36)}`;
const BOLD_SHORTCUT = process.platform === 'darwin' ? 'Meta+b' : 'Control+b';

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

async function pngFile(name: string, width: number, height: number) {
  const buffer = await Sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 130 } },
  })
    .png()
    .toBuffer();
  return { name, mimeType: 'image/png', buffer };
}

/** Upload via la médiathèque + attente du `ready` + alt (requis à la publication). */
async function uploadReadyMedia(page: Page, alt: string): Promise<string> {
  await page.goto('/admin/media');
  const before = await page.locator('.kz-media-card', { hasText: 'Prêt' }).count();
  await page.getByLabel('Ajouter une image').setInputFiles(await pngFile(`${alt}.png`, 640, 400));
  await page.getByRole('button', { name: 'Uploader' }).click();
  await expect(page.locator('.kz-media-card', { hasText: 'Prêt' })).toHaveCount(before + 1, {
    timeout: 30_000,
  });
  // Le média nouvellement prêt est le plus récent ; son alt est encore vide.
  const rows = await query<{ id: string }>(
    "select id from kreiz_media where alt_text = '' and status = 'ready' order by created_at desc limit 1",
  );
  const id = rows[0]!.id;
  const card = page.locator('.kz-media-card', { has: page.locator(`#alt-${id}`) });
  await card.locator('input[name="alt_text"]').fill(alt);
  await card.getByRole('button', { name: 'Enregistrer le texte alternatif' }).click();
  await expect(page).toHaveURL(/alt=1/);
  return id;
}

test.describe('back-office — éditeur riche (slice 6)', () => {
  test('saisie riche (gras, titre 2, liste) → Save → reload → document intact', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article riche ${runId}`);
    await page.getByLabel('Accroche').fill('Accroche riche.');
    await page.getByLabel('Auteur').fill('Auteure Riche');

    // Saisie réelle au clavier + toolbar.
    await page.getByLabel('Corps').click();
    await page.keyboard.type('Titre de section');
    await page.getByRole('button', { name: 'Titre de niveau 2' }).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Voici un paragraphe avec du ');
    await page.keyboard.press(BOLD_SHORTCUT);
    await page.keyboard.type('gras');
    await page.keyboard.press(BOLD_SHORTCUT);
    await page.keyboard.type(' dedans.');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Liste à puces' }).click();
    await page.keyboard.type('Un élément de liste');

    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    // Création : redirection 303 vers la page d'édition (sans bandeau).
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
    const id = entryIdFromUrl(page.url());

    // Persistance : document canonique avec heading/bold/bulletList.
    const rows = await query<{ data: { body: unknown } }>(
      'select data from kreiz_content_entries where id = $1',
      [id],
    );
    const body = rows[0]!.data.body as {
      version: number;
      type: string;
      content: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({ version: 1, type: 'doc' });
    const types = body.content.map((node) => node['type']);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bulletList');
    expect(JSON.stringify(body)).toContain('"bold"');
    expect(JSON.stringify(body)).toContain('"level":2');
    // Aucun attribut parasite dans le stockage.
    expect(JSON.stringify(body)).not.toContain('style');

    // Reload : le document est restauré sans corruption (mission §35.7).
    await page.reload();
    await expect(page.getByLabel('Corps')).toContainText('Titre de section');
    await expect(page.getByLabel('Corps')).toContainText('gras');
    const restored = await editorDocument(page);
    expect(restored.content.map((node) => node['type'])).toEqual(types);
  });

  test('Save ≠ Publish sur le corps : A publié → public A, Save B sans effet, Publish → B', async ({
    page,
  }) => {
    await login(page);
    const slug = `article-sp-corps-${runId}`;
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article save/publish corps ${runId}`);
    await page.getByLabel('Slug').fill(slug);
    await page.getByLabel('Accroche').fill('Accroche save/publish.');
    await page.getByLabel('Corps').fill('Corps version A.');
    await page.getByLabel('Auteur').fill('Auteure SP');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    const id = entryIdFromUrl(page.url());

    // Publish A → snapshot figé à A. (L'affichage HTML **statique** du
    // snapshot est prouvé sur build réel par public-build.test.ts ; en dev,
    // Astro met en cache les getStaticPaths — un slug publié en cours de
    // série n'est pas fiable à l'écran.)
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1/);
    const publishedRow = await query<{ published_data: { body: unknown } }>(
      'select published_data from kreiz_content_entries where id = $1',
      [id],
    );
    expect(bodyText(publishedRow[0]!.published_data.body)).toBe('Corps version A.');

    // Save B : aucun effet public — le snapshot reste A.
    await page.goto(`/admin/content/article/${id}`);
    await page.getByLabel('Corps').fill('Corps version B — non publiée.');
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(/saved=1/);
    const rows = await query<{ data: { body: unknown }; published_data: { body: unknown } }>(
      'select data, published_data from kreiz_content_entries where id = $1',
      [id],
    );
    expect(bodyText(rows[0]!.data.body)).toBe('Corps version B — non publiée.');
    expect(bodyText(rows[0]!.published_data.body)).toBe('Corps version A.');

    // Publish → snapshot bascule vers B.
    await page.goto(`/admin/content/article/${id}`);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1/);
    const updated = await query<{ published_data: { body: unknown } }>(
      'select published_data from kreiz_content_entries where id = $1',
      [id],
    );
    expect(bodyText(updated[0]!.published_data.body)).toBe('Corps version B — non publiée.');

    // La preview SSR (état courant) et la projection publiée diffèrent
    // désormais : c'est B l'un et l'autre après republication.
    await page.goto(`/admin/preview/${id}`);
    await expect(page.getByText('Corps version B — non publiée.')).toBeVisible();
  });

  test('média ready via le picker → légende → Save → Publish → figure rendue en preview', async ({
    page,
  }) => {
    await login(page);
    const alt = `Image corps ${runId}`;
    await uploadReadyMedia(page, alt);

    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article média corps ${runId}`);
    await page.getByLabel('Accroche').fill('Accroche média.');
    await page.getByLabel('Auteur').fill('Auteure Média');
    await page.getByLabel('Corps').click();
    await page.keyboard.type('Avant image.');
    await page.getByRole('button', { name: 'Insérer une image de la médiathèque' }).click();
    const dialog = page.locator('[data-role="richtext-picker"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-role="richtext-pick"]').filter({ hasText: alt }).click();
    await expect(dialog).not.toBeVisible();

    // Légende éditoriale dans le node média.
    await page.locator('.kz-richtext-media__caption').fill('Légende E2E du corps');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
    const id = entryIdFromUrl(page.url());

    // Stockage : référence média (mediaId), jamais d'URL ni d'HTML embarqué.
    await page.reload();
    const stored = JSON.stringify(await editorDocument(page));
    expect(stored).toContain('mediaId');
    expect(stored).toContain('Légende E2E du corps');
    expect(stored).not.toMatch(/https?:\/\//);
    expect(stored).not.toContain('src=');

    // Publish → la preview (même template que le public) rend la figure
    // picture/figcaption via le pipeline slice 5. La preuve du HTML **statique
    // final** (build réel) est faite par public-build.test.ts (intégration).
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1/);
    await page.goto(`/admin/preview/${id}`);
    const figure = page.locator('[data-kreiz-media]');
    await expect(figure).toBeVisible();
    await expect(figure.locator('picture')).toBeVisible();
    await expect(figure.locator('figcaption')).toHaveText('Légende E2E du corps');
    const imgSrc = await figure.locator('img').getAttribute('src');
    expect(imgSrc).toMatch(/\/media\/[0-9a-f-]{36}\/400\.webp$/);
  });

  test('média non prêt dans le corps : Save accepté, publication refusée explicitement', async ({
    page,
  }) => {
    await login(page);

    // État d'infrastructure : un média `failed` + un article dont le corps le
    // référence (mutation SQL limitée au setup de test).
    const failedId = crypto.randomUUID();
    const adminId = (
      await query<{ id: string }>('select id from kreiz_admin_users where email = $1', [adminEmail])
    )[0]!.id;
    await query(
      "insert into kreiz_media (id, status, failure_reason, storage_key, mime, size_bytes, alt_text, uploaded_by) values ($1, 'failed', 'transform-failed', $2, 'image/png', 10, 'Média échoué corps', $3)",
      [failedId, `media/${failedId}/original`, adminId],
    );
    const doc = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Corps avec média cassé.' }] },
        { type: 'media', attrs: { mediaId: failedId, caption: '' } },
      ],
    };
    await query(
      `insert into kreiz_content_entries
         (content_type, route_namespace, title, slug, status, data, created_by, updated_by)
       values ('article', 'articles', $1, $2, 'draft', $3::jsonb, $4, $4)`,
      [
        `Article média cassé ${runId}`,
        `article-media-casse-${runId}`,
        JSON.stringify({ excerpt: 'Accroche.', body: doc, author: 'Auteure' }),
        adminId,
      ],
    );

    // L'éditeur ouvre le document avec un état visible « média indisponible »
    // (référence éditable) ; le Save passe — la forme reste valide.
    await page.goto('/admin/content/article');
    await page.getByRole('link', { name: `Article média cassé ${runId}` }).click();
    const id = entryIdFromUrl(page.url());
    await expect(page.locator('.kz-richtext-media--missing')).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/saved=1/);

    // La publication est refusée explicitement, avec le bandeau de validation.
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/publish_error=validation/);
    await expect(page.locator('.kz-banner--warning')).toContainText(/Publication impossible/);
    const row = await query<{ status: string; published_data: unknown }>(
      'select status, published_data from kreiz_content_entries where id = $1',
      [id],
    );
    expect(row[0]!.status).toBe('draft');
    expect(row[0]!.published_data).toBeNull();
  });

  test('lien externe : rendu avec target/rel politique, jamais javascript:', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article liens ${runId}`);
    await page.getByLabel('Accroche').fill('Accroche liens.');
    await page.getByLabel('Corps').click();
    await page.keyboard.type('Voir la documentation externe.');
    // Sélection du texte : setLink exige une sélection non vide. (Les touches
    // Home/Shift+End sont avalées par le keymap de ProseMirror — Mod+A passe.)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.getByRole('button', { name: 'Insérer un lien' }).click();

    const linkDialog = page.locator('[data-role="richtext-link-dialog"]');
    await expect(linkDialog).toBeVisible();
    await page.locator('[data-role="richtext-link-input"]').fill('javascript:alert(1)');
    await linkDialog.getByRole('button', { name: 'Appliquer' }).click();
    // Refus côté éditeur : message explicite, dialogue ouvert.
    await expect(linkDialog.locator('[data-role="richtext-link-error"]')).toContainText(/non autorisé/);

    await page.locator('[data-role="richtext-link-input"]').fill('https://exemple.fr/docs');
    await linkDialog.getByRole('button', { name: 'Appliquer' }).click();
    await expect(linkDialog).not.toBeVisible();

    await page.getByLabel('Auteur').fill('Auteure Liens');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);
    const id = entryIdFromUrl(page.url());

    // href seul stocké — target/rel sont décidés au rendu (jamais stockés).
    const stored = JSON.stringify(await editorDocument(page));
    expect(stored).toContain('"href":"https://exemple.fr/docs"');
    expect(stored).not.toContain('"target"');
    expect(stored).not.toContain('"rel"');
    expect(stored).not.toContain('javascript');

    // Preview : lien rendu selon la politique déterministe du renderer.
    await page.goto(`/admin/preview/${id}`);
    const anchor = page.locator('a[href="https://exemple.fr/docs"]');
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('collage formaté : styles/classes/protocoles dangereux normalisés au stockage', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article collage ${runId}`);
    await page.getByLabel('Accroche').fill('Accroche collage.');
    await page.getByLabel('Corps').click();

    // Colle du HTML « Word-like » + hostile dans l'éditeur réel.
    await page.evaluate(() => {
      const html =
        '<meta charset="utf-8"><div>' +
        '<p style="color:red;margin:0" class="MsoNormal" id="p1">Paragraphe collé</p>' +
        '<h2 style="font-size:30px">Titre collé</h2>' +
        '<span style="font-weight:bold">Gras collé</span>' +
        '<a href="javascript:alert(1)">piège</a>' +
        '</div>';
      const transfer = new DataTransfer();
      transfer.setData('text/html', html);
      transfer.setData('text/plain', 'Paragraphe collé');
      const target = document.querySelector('.kz-richtext__content');
      target?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    });

    await page.getByLabel('Auteur').fill('Auteure Collage');
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);

    // Stockage normalisé : structure conservée, aucun attribut parasite.
    const stored = JSON.stringify(await editorDocument(page));
    expect(stored).toContain('Paragraphe collé');
    expect(stored).toContain('Titre collé');
    expect(stored).toContain('bold');
    expect(stored).toContain('"heading"');
    expect(stored).not.toContain('style');
    expect(stored).not.toContain('class');
    expect(stored).not.toContain('MsoNormal');
    expect(stored).not.toContain('javascript');
    expect(stored).not.toContain('"type":"link"');
  });
});
