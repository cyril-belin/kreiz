import { expect, type Page, test } from '@playwright/test';
import Sharp from 'sharp';
import { query } from './db';

/**
 * Parcours critiques du slice 5 — médias (mission §52). Le navigateur
 * exécute l'upload **direct** vers le serveur S3 local contrôlé (s3rver,
 * démarré par la config Playwright) : la chaîne complète
 * presign → PUT navigateur → confirm → processing → variantes → ready est
 * exercée en réel. La base n'est touchée que pour vérifier les effets
 * serveur et poser des états d'infrastructure ; les lignes média créées via
 * l'UI sont nettoyées par le global-teardown.
 */

const publicBaseUrl = process.env.E2E_STORAGE_PUBLIC_BASE_URL ?? '';
const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const runId = Math.random().toString(36).slice(2, 8);

/** État partagé entre tests — fichier temporaire (un redémarrage de worker
 * Playwright réimporte le module : l'état module seul n'est pas fiable). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = join(import.meta.dirname, '.media-state.json');
type MediaState = { coverAId: string; coverBId: string; articleId: string };

function saveMediaState(state: MediaState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function readMediaState(): MediaState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as MediaState;
}

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function pngFile(name: string, width: number, height: number): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const buffer = await Sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 110, b: 90 } },
  })
    .png()
    .toBuffer();
  return { name, mimeType: 'image/png', buffer };
}

async function uploadThroughUi(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.goto('/admin/media');
  await page.getByLabel('Ajouter une image').setInputFiles(file);
  await page.getByRole('button', { name: 'Uploader' }).click();
}

/**
 * Cartes « Prêt » de la grille — comptage **démentiellement fiable** : le
 * rechargement automatique (polling terminal, mission §35) est la seule
 * façon pour ce comptage d'atteindre sa cible, donc attendre un comptage
 * attend la fin réelle du traitement, jamais un état intermédiaire.
 */
function readyCards(page: Page): ReturnType<Page['locator']> {
  return page.locator('.kz-media-card', { hasText: 'Prêt' });
}

/** Upload via l'UI puis attente du passage à `ready` (+1 carte, page rechargée).
 * Le comptage « avant » est mesuré **sur la grille** (après goto) : mesurer
 * sur la page courante (dashboard, autre route) renverrait 0 et rendrait la
 * cible fausse dès qu'un média préexiste. */
async function uploadAndWaitReady(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.goto('/admin/media');
  const before = await readyCards(page).count();
  await page.getByLabel('Ajouter une image').setInputFiles(file);
  await page.getByRole('button', { name: 'Uploader' }).click();
  await expect(readyCards(page)).toHaveCount(before + 1, { timeout: 30_000 });
}

/** Pose l'alt text d'une carte (par le formulaire dédié) et attend la confirmation. */
async function setAlt(page: Page, card: ReturnType<Page['locator']>, alt: string): Promise<void> {
  const input = card.locator('input[name="alt_text"]');
  await input.fill(alt);
  await card.getByRole('button', { name: 'Enregistrer le texte alternatif' }).click();
  await expect(page).toHaveURL(/alt=1/);
  await page.goto('/admin/media');
}

async function mediaIdByAlt(alt: string): Promise<string | null> {
  const rows = await query<{ id: string }>('select id from kreiz_media where alt_text = $1', [alt]);
  return rows[0]?.id ?? null;
}

test.describe('back-office — médias (slice 5)', () => {
  test('upload direct : presign → PUT navigateur → processing → variantes → ready', async ({
    page,
  }) => {
    await login(page);
    await uploadAndWaitReady(page, await pngFile('couverture.png', 900, 600));

    // Le traitement asynchrone se termine pendant le polling client : la
    // page se recharge d'elle-même sur l'état terminal (mission §35) —
    // la carte « Prêt » n'apparaît qu'après ce rechargement.

    // Vérification en base : row ready, dimensions réelles, variantes générées.
    const rows = await query<{
      id: string;
      status: string;
      width: number;
      height: number;
      mime: string;
      variants: Array<{ key: string; width: number; format: string }>;
    }>('select id, status, width, height, mime, variants from kreiz_media where alt_text = \'\' order by created_at desc limit 1');
    const mediaId = rows[0]!.id;
    expect(rows[0]).toMatchObject({ status: 'ready', width: 900, height: 600, mime: 'image/png' });
    // 900 px de source : 400 + 800 produits, jamais d'upscale (mission §13).
    expect(rows[0]!.variants.map((variant) => variant.width).sort((a, b) => a - b)).toEqual([400, 400, 800, 800]);

    // Les objets existent réellement dans le stockage local : la miniature
    // du grid et la variante AVIF sont servies depuis la base publique.
    const thumbnail = page.locator('.kz-media-card img').first();
    await expect(thumbnail).toHaveAttribute('src', new RegExp(`media/${mediaId}/400\\.webp`));
    const variantResponse = await page.request.get(`${publicBaseUrl}/media/${mediaId}/400.avif`);
    expect(variantResponse.status()).toBe(200);

    // L'original privé n'a jamais d'URL publique exposée dans la page admin.
    const adminHtml = await page.content();
    expect(adminHtml).not.toContain(`/media/${mediaId}/original`);

    // Alt text via le formulaire dédié → persisté + audité.
    await setAlt(page, page.locator('.kz-media-card', { has: page.locator(`#alt-${mediaId}`) }), `Upload E2E ${runId}`);
    const actions = await query<{ action: string; actor_admin_id: string | null }>(
      'select action, actor_admin_id from kreiz_admin_audit_log where entity_type = $1 and entity_id = $2 order by created_at',
      ['media', mediaId],
    );
    expect(actions.map((row) => row.action)).toEqual([
      'media.created',
      'media.ready',
      'media.alt_updated',
    ]);
    // L'acteur du processing système est honnête : NULL (mission §44).
    expect(actions.find((row) => row.action === 'media.ready')?.actor_admin_id).toBeNull();
    expect(actions.find((row) => row.action === 'media.created')?.actor_admin_id).not.toBeNull();
  });

  test('fichier maquillé (extension .png, bytes texte) → failed, retry visible et audité', async ({
    page,
  }) => {
    await login(page);
    const fake = {
      name: 'fausse-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from('ceci n est pas une image', 'utf8'),
    };
    await uploadThroughUi(page, fake);

    // La confirmation refuse l'objet réel (magic bytes) — message affiché.
    await expect(page.locator('[data-role="message"]')).toContainText(/refusé/i, { timeout: 15_000 });

    // Rechargement : la carte est en échec avec sa raison courte.
    await page.reload();
    const card = page.locator('.kz-media-card', { hasText: 'Échec' }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('mime-unsupported');

    // Retry : mutation audité, le média repasse processing puis re-échoue
    // (le contenu reste invalide — pas de retry automatique infini).
    const failed = await query<{ id: string }>(
      "select id from kreiz_media where status = 'failed' order by created_at desc limit 1",
    );
    const mediaId = failed[0]!.id;
    await card.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page).toHaveURL(/\?retry=1/);
    const actions = await query<{ action: string }>(
      'select action from kreiz_admin_audit_log where entity_type = $1 and entity_id = $2 order by created_at',
      ['media', mediaId],
    );
    expect(actions.map((row) => row.action)).toContain('media.retried');
    await page.reload();
    await expect(page.locator('.kz-media-card', { hasText: 'Échec' }).first()).toBeVisible();
  });

  test('type MIME hors politique refusé avant toute présignature (SVG)', async ({ page }) => {
    await login(page);
    const svg = {
      name: 'vector.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
    };
    await uploadThroughUi(page, svg);
    await expect(page.locator('[data-role="message"]')).toContainText(/non supporté/i);
    const rows = await query<{ id: string }>("select id from kreiz_media where mime = 'image/svg+xml'");
    expect(rows).toHaveLength(0);
  });

  test('picker : choisir une couverture ready depuis le formulaire Article (mission §52)', async ({
    page,
  }) => {
    const altA = `Cover A ${runId}`;
    const altB = `Cover B ${runId}`;
    await login(page);

    // Deux médias ready — A servira de couverture, B de changement. On
    // attend le **comptage** de cartes prêtes (1 issue du premier test,
    // puis 2, puis 3) : chaque cible n'est atteignable qu'une fois
    // l'upload correspondant terminé et la page rechargée.
    await uploadAndWaitReady(page, await pngFile('cover-a.png', 640, 480));
    await uploadAndWaitReady(page, await pngFile('cover-b.png', 640, 480));

    // Alts posés pour identifier les options du select (mission §16 : le
    // picker montre l'alt). Les deux cartes sans alt sont les deux dernières
    // uploadées : alts posés par ordre de création croissante (A puis B).
    const emptyRows = await query<{ id: string }>(
      "select id from kreiz_media where alt_text = '' and status = 'ready' order by created_at asc limit 2",
    );
    await setAlt(page, page.locator('.kz-media-card', { has: page.locator(`#alt-${emptyRows[0]!.id}`) }), altA);
    await setAlt(page, page.locator('.kz-media-card', { has: page.locator(`#alt-${emptyRows[1]!.id}`) }), altB);
    expect(await mediaIdByAlt(altA)).toBe(emptyRows[0]!.id);
    expect(await mediaIdByAlt(altB)).toBe(emptyRows[1]!.id);
    console.log('[DIAG] emptyRows:', JSON.stringify(emptyRows));
    console.log('[DIAG] all media:', JSON.stringify(await query<{ id: string; alt_text: string; status: string }>('select id, alt_text, status from kreiz_media order by created_at')));

    // Création d'un Article avec la couverture A.
    await page.goto('/admin/content/article/new');
    await page.getByRole('textbox', { name: 'Titre' }).fill(`Article média ${runId}`);
    await page.getByLabel('Accroche').fill('Accroche couverture.');
    await page.getByLabel('Corps').fill('Corps de l’article média.');
    await page.getByLabel('Auteur').fill('Auteure Média');
    await page.getByLabel('Image de couverture').selectOption({ label: altA });
    await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(page).toHaveURL(/\/admin\/content\/article\/[0-9a-f-]{36}$/);

    // Le champ système `cover_media_id` est persisté, jamais dans `data`.
    const entryId = page.url().split('/').at(-1) ?? '';
    const entry = await query<{ cover_media_id: string; data: Record<string, unknown> }>(
      'select cover_media_id, data from kreiz_content_entries where id = $1',
      [entryId],
    );
    expect(entry[0]!.cover_media_id).toBe(emptyRows[0]!.id);
    expect(Object.keys(entry[0]!.data)).not.toContain('cover');
    expect(Object.keys(entry[0]!.data)).not.toContain('cover_media_id');

    // Partage avec les tests suivants via fichier (fiable malgré les
    // redémarrages de worker).
    saveMediaState({ coverAId: emptyRows[0]!.id, coverBId: emptyRows[1]!.id, articleId: entryId });
  });

  test('Save != Publish sur la couverture : snapshot figé à A, preview = B, Publish → B', async ({
    page,
  }) => {
    const altB = `Cover B ${runId}`;
    const state = readMediaState();
    expect(state.coverAId).not.toBe('');
    expect(state.coverBId).not.toBe('');
    expect(state.articleId).not.toBe('');
    await login(page);

    // Publier l'article avec la couverture A.
    await page.goto(`/admin/content/article/${state.articleId}`);
    await page.getByRole('button', { name: 'Publier', exact: true }).click();
    await expect(page).toHaveURL(/published=1/);

    // Snapshot : published_cover_media_id = A au moment du Publish.
    const afterPublish = await query<{ cover_media_id: string; published_cover_media_id: string }>(
      'select cover_media_id, published_cover_media_id from kreiz_content_entries where id = $1',
      [state.articleId],
    );
    expect(afterPublish[0]).toMatchObject({
      cover_media_id: state.coverAId,
      published_cover_media_id: state.coverAId,
    });

    // Page publique (premier rendu) : couverture A.
    await page.goto(`/articles/article-media-${runId}`);
    await expect(page.locator('[data-kreiz-cover] img')).toHaveAttribute(
      'src',
      new RegExp(`media/${state.coverAId}/400\\.webp`),
    );

    // Save avec couverture B — aucun effet public (contrat Save != Publish,
    // mission §28 : le snapshot de couverture protège le prochain rebuild,
    // déclenché par la publication de n'importe quel autre contenu).
    await page.goto(`/admin/content/article/${state.articleId}`);
    await page.getByLabel('Image de couverture').selectOption({ label: altB });
    await page.getByRole('button', { name: 'Enregistrer (sans publier)' }).click();
    await expect(page).toHaveURL(/saved=1/);

    const afterSave = await query<{ cover_media_id: string; published_cover_media_id: string }>(
      'select cover_media_id, published_cover_media_id from kreiz_content_entries where id = $1',
      [state.articleId],
    );
    expect(afterSave[0]).toMatchObject({
      cover_media_id: state.coverBId, // courant = B
      published_cover_media_id: state.coverAId, // public figé = A
    });

    // Preview = B (état éditorial courant, SSR par requête).
    await page.goto(`/admin/content/article/${state.articleId}`);
    await page.getByRole('link', { name: 'Preview' }).click();
    await expect(page.locator('[data-kreiz-cover] img')).toHaveAttribute(
      'src',
      new RegExp(`media/${state.coverBId}/400\\.webp`),
    );

    // Publish → le snapshot bascule vers B (le rendu HTML public de cette
    // version est prouvé sur build réel par public-build.test.ts — en dev,
    // Astro met en cache les pages prérendues).
    await page.goto(`/admin/content/article/${state.articleId}`);
    await page.getByRole('button', { name: 'Publier les modifications' }).click();
    await expect(page).toHaveURL(/published=1/);
    const afterRepublish = await query<{
      status: string;
      cover_media_id: string;
      published_cover_media_id: string;
    }>('select status, cover_media_id, published_cover_media_id from kreiz_content_entries where id = $1', [
      state.articleId,
    ]);
    expect(afterRepublish[0]).toMatchObject({
      status: 'published',
      cover_media_id: state.coverBId,
      published_cover_media_id: state.coverBId,
    });
  });

  test('un média non ready n’est jamais sélectionnable (mission §52)', async ({ page }) => {
    // Ligne `uploading` — upload demandé, jamais confirmé (état d'infrastructure).
    const adminId = (
      await query<{ id: string }>('select id from kreiz_admin_users where email = $1', [adminEmail])
    )[0]!.id;
    const pendingId = crypto.randomUUID();
    await query(
      "insert into kreiz_media (id, status, storage_key, mime, size_bytes, alt_text, uploaded_by) values ($1, 'uploading', $2, 'image/png', 10, $3, $4)",
      [pendingId, `media/${pendingId}/original`, `Pending ${runId}`, adminId],
    );

    await login(page);
    await page.goto('/admin/content/article/new');
    const options = await page.getByLabel('Image de couverture').locator('option').allTextContents();
    expect(options.join('\n')).not.toContain(`Pending ${runId}`);

    // Visible dans la médiathèque avec son état explicite (l'alt est la
    // *valeur* de l'input : on localise la carte par son id d'input).
    await page.goto('/admin/media');
    await expect(
      page.locator('.kz-media-card', { has: page.locator(`#alt-${pendingId}`) }),
    ).toContainText('En attente');
  });

  test('suppression : média utilisé refusé, média libre supprimé (mission §52)', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/media');
    const state = readMediaState();
    expect(state.coverAId).not.toBe('');

    // La couverture B est référencée (courante + snapshot publié après le
    // second Publish) → refus avec message explicite.
    await page
      .locator('.kz-media-card', { has: page.locator(`#alt-${state.coverBId}`) })
      .getByRole('button', { name: 'Supprimer' })
      .click();
    await expect(page).toHaveURL(/delete=in-use/);
    await expect(page.locator('.kz-banner--warning')).toContainText(/utilisé par au moins un contenu/i);
    const rowsAfterRefusal = await query<{ id: string }>('select id from kreiz_media where id = $1', [state.coverBId]);
    expect(rowsAfterRefusal).toHaveLength(1);

    // La couverture A, remplacée partout par B (courante ET snapshot), n'est
    // plus référencée : sa suppression réussit — sémantique exacte du §26.
    await page
      .locator('.kz-media-card', { has: page.locator(`#alt-${state.coverAId}`) })
      .getByRole('button', { name: 'Supprimer' })
      .click();
    await expect(page).toHaveURL(/delete=1/);
    const rowsAfterDelete = await query<{ id: string }>('select id from kreiz_media where id = $1', [state.coverAId]);
    expect(rowsAfterDelete).toHaveLength(0);

    // Un média libre part avec ses objets storage (3 ready → 4).
    const freeAlt = `Cover libre ${runId}`;
    await uploadAndWaitReady(page, await pngFile('libre.png', 500, 500));
    await page.goto('/admin/media');
    const freeRow = await query<{ id: string }>(
      "select id from kreiz_media where alt_text = '' and status = 'ready' order by created_at desc limit 1",
    );
    const freeId = freeRow[0]!.id;
    await setAlt(page, page.locator('.kz-media-card', { has: page.locator(`#alt-${freeId}`) }), freeAlt);
    await page
      .locator('.kz-media-card', { has: page.locator(`#alt-${freeId}`) })
      .getByRole('button', { name: 'Supprimer' })
      .click();
    await expect(page).toHaveURL(/delete=1/);
    expect(await mediaIdByAlt(freeAlt)).toBeNull();
    const gone = await page.request.get(`${publicBaseUrl}/media/${freeId}/400.webp`);
    expect(gone.status()).toBe(404);
  });
});
