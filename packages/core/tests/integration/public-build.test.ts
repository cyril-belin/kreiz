import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createAdminUsersRepository,
  type KreizAdminUser,
} from '../../src/data';
import { createContentEntriesRepository } from '../../src/data/repositories/content-entries';
import { createMediaRepository } from '../../src/data/repositories/media';
import { createRedirectsRepository } from '../../src/data/repositories/redirects';
import {
  describeIntegration,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Preuve du **chemin public build-time** (revue slice 3, étendue slice 4 —
 * mission §46, scénarios regroupés sur **un seul build réussi**) :
 *
 *   published entry en DB → build Astro → createContentReader → projections
 *   publiées (snapshots) → registre Project → template .astro → HTML statique
 *   + redirections 301 matérialisées dans `config.json` Vercel
 *
 * Scénarios du build réussi (un seul build coûteux) :
 * 1. publié valide → page statique au **slug public** (`published_slug`) ;
 * 2. published dont le slug éditorial a dérivé (Save ≠ Publish) → page à
 *    l'ancienne adresse publique uniquement ;
 * 3. brouillon → aucune page ;
 * 4. publié puis soft-deleted → aucune page ;
 * 5. dépublié → aucune page, et son ancienne redirection (cible morte) n'est
 *    PAS matérialisée ;
 * 6. redirection vivante → route 301 dans `.vercel/output/config.json`
 *    (sortie Vercel réelle, mission §47), source sans page statique ;
 * 7. **couverture publiée** (slice 5) → `<picture>` responsive dans le HTML
 *    statique : URLs WebP/AVIF construites depuis la base publique,
 *    width/height, alt — et **aucune** URL d'original ni URL signée.
 *
 * Deuxième build (échec attendu) : un contenu publié au `data` invalide fait
 * échouer explicitement le build (contrat du lecteur, mission §39).
 *
 * Les fixtures reproduisent l'état qu'un Publish laisse en base (snapshots
 * `published_*` — Publish est l'unique écrivain, couvert par les tests du
 * service). Aucune donnée résiduelle : fixtures + redirections supprimées en
 * `afterAll`, artefacts statiques retirés.
 */

const runId = crypto.randomUUID().slice(0, 8);
const emailPattern = `it-${runId}%@example.test`;

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'apps', 'demo');
const OUTPUT_ROOT = join(DEMO_ROOT, '.vercel', 'output');
const STATIC_ROOT = join(OUTPUT_ROOT, 'static');
const CORE_DIST = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');

// Les fixtures doivent correspondre **exactement** aux déclarations du demo
// (content_type 'article', route_namespace 'articles') pour que le lecteur
// de build les résolve.
const publishedSlug = `build-proof-${runId}`;
const driftCurrentSlug = `build-drift-new-${runId}`;
const driftPublicSlug = `build-drift-pub-${runId}`;
const draftSlug = `build-proof-draft-${runId}`;
const deletedSlug = `build-proof-deleted-${runId}`;
const unpublishedPublicSlug = `build-unpub-${runId}`;
const invalidSlug = `build-proof-invalid-${runId}`;
const redirectedFrom = `build-redirected-${runId}`;
const deadRedirectFrom = `build-dead-redirect-${runId}`;

// Média de couverture — état exact d'un média ready passé par le pipeline.
const coverMediaId = crypto.randomUUID();
const coverAlt = `Couverture build ${runId}`;
const coverVariants = [
  { key: `media/${coverMediaId}/400.webp`, width: 400, format: 'webp', sizeBytes: 30_000 },
  { key: `media/${coverMediaId}/400.avif`, width: 400, format: 'avif', sizeBytes: 25_000 },
  { key: `media/${coverMediaId}/800.webp`, width: 800, format: 'webp', sizeBytes: 60_000 },
];
const MEDIA_PUBLIC_BASE_URL = 'https://media.example.test/cdn';

const title = `Article Build Proof ${runId}`;
const driftPublicTitle = `Titre public figé ${runId}`;
const excerpt = `Accroche publique ${runId}`;
const author = `Auteure Build ${runId}`;
const validData = { excerpt, body: `Corps public ${runId}.`, author };

let harness: IntegrationHarness;
let entries: ReturnType<typeof createContentEntriesRepository>;
let mediaRepo: ReturnType<typeof createMediaRepository>;
let redirectsRepo: ReturnType<typeof createRedirectsRepository>;
let admin: KreizAdminUser;

function databaseUrlForBuild(): string {
  const url = process.env.KREIZ_DATABASE_URL ?? process.env.KREIZ_TEST_DATABASE_URL ?? '';
  if (!url) {
    throw new Error('Aucune URL de base disponible pour le build de apps/demo.');
  }
  return url;
}

function runDemoBuild(): { status: number | null; stdout: string; stderr: string } {
  // Le vrai build Astro de l'application consommatrice — pas de raccourci :
  // mêmes pages, même adapter Vercel, mêmes redirections que le déploiement.
  return spawnSync(
    process.execPath,
    ['./node_modules/astro/bin/astro.mjs', 'build'],
    {
      cwd: DEMO_ROOT,
      env: {
        ...process.env,
        KREIZ_DATABASE_URL: databaseUrlForBuild(),
        KREIZ_STORAGE_PUBLIC_BASE_URL: MEDIA_PUBLIC_BASE_URL,
        ASTRO_TELEMETRY_DISABLED: '1',
      },
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

function* walkMjsFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMjsFiles(full);
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) yield full;
  }
}

/** Fixture « tel qu'un Publish laisse la ligne en base ». */
function publishedRow(values: {
  slug: string;
  publishedSlug: string;
  title?: string;
  publishedTitle?: string;
  data?: Record<string, unknown>;
  publishedData?: Record<string, unknown> | null;
  publishedAt?: Date;
  deletedAt?: Date;
  status?: 'draft' | 'published';
  /** Couverture éditoriale + snapshot public (slice 5) — optionnelle. */
  coverMediaId?: string | null;
}) {
  return {
    contentType: 'article',
    routeNamespace: 'articles',
    title: values.title ?? `Article ${values.slug}`,
    slug: values.slug,
    status: values.status ?? ('published' as const),
    publishedAt: values.publishedAt ?? new Date(),
    publishedSlug: values.publishedSlug,
    publishedTitle: values.publishedTitle ?? values.title ?? `Article ${values.slug}`,
    publishedData:
      values.publishedData === undefined ? (values.data ?? validData) : values.publishedData,
    publishedSeo: {},
    publishedCoverMediaId: values.coverMediaId ?? null,
    data: values.data ?? validData,
    coverMediaId: values.coverMediaId ?? null,
    deletedAt: values.deletedAt ?? null,
    createdBy: admin.id,
    updatedBy: admin.id,
  };
}

describeIntegration('chemin public build-time — published → build Astro → HTML statique + redirects', () => {
  beforeAll(async () => {
    // Le build du demo importe @kreiz/core depuis dist/ (comme le CI).
    if (!existsSync(CORE_DIST)) {
      throw new Error(
        `Build de apps/demo impossible : @kreiz/core n'est pas buildé (${CORE_DIST}). Exécuter « pnpm --filter @kreiz/core build ».`,
      );
    }
    harness = await setupIntegration();
    entries = createContentEntriesRepository(harness.db);
    mediaRepo = createMediaRepository(harness.db);
    redirectsRepo = createRedirectsRepository(harness.db);
    const users = createAdminUsersRepository(harness.db);
    admin = await withTransientNetworkRetry(() =>
      users.create({
        email: `it-${runId}-admin@example.test`,
        passwordHash: 'hash-test-argon2id',
        name: 'Admin build proof',
      }),
    );
  }, 60_000);

  afterAll(async () => {
    if (!harness) return;
    // Fixtures supprimées par slug préfixé + auteur de test — jamais par
    // namespace (le namespace 'articles' peut contenir du contenu réel).
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_redirects where from_path like ${'/articles/build-%'}`),
    );
    await withTransientNetworkRetry(() =>
      harness.raw(sql`delete from kreiz_content_entries where slug like ${'build-%'} and created_by = ${admin.id}`),
    );
    await harness.raw(sql`delete from kreiz_media where uploaded_by = ${admin.id}`);
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    // La sortie de build retrouve son état « 0 page dynamique » (artefacts
    // git-ignorés, régénérés au prochain build).
    for (const dir of ['articles', 'guides', 'realisations']) {
      rmSync(join(STATIC_ROOT, dir), { recursive: true, force: true });
    }
    await harness.close();
  }, 60_000);

  it('les scénarios de publication produisent le bon site statique + les redirections 301 Vercel', async () => {
    // Média de couverture — état exact laissé par le pipeline (ready + variantes).
    await withTransientNetworkRetry(() =>
      mediaRepo.createUploading({
        id: coverMediaId,
        storageKey: `media/${coverMediaId}/original`,
        mime: 'image/png',
        sizeBytes: 120_000,
        width: 1000,
        height: 500,
        altText: coverAlt,
        variants: coverVariants,
        uploadedBy: admin.id,
      }),
    );
    await mediaRepo.markProcessing(coverMediaId, { updatedAt: new Date() });
    await mediaRepo.markReady(coverMediaId, {
      width: 1000,
      height: 500,
      variants: coverVariants,
      updatedAt: new Date(),
    });

    // 1. Article publié valide — page à son slug public, avec couverture.
    await withTransientNetworkRetry(() =>
      entries.create(publishedRow({ slug: publishedSlug, publishedSlug, title, coverMediaId })),
    );
    // 2. Published au slug éditorial dérivé : la page publique reste à
    //    l'ancienne adresse (snapshots) — Save != Publish au build.
    await withTransientNetworkRetry(() =>
      entries.create(
        publishedRow({
          slug: driftCurrentSlug,
          publishedSlug: driftPublicSlug,
          title: `Titre courant ${runId}`,
          publishedTitle: driftPublicTitle,
          data: { excerpt: `Accroche courante ${runId}`, body: `Corps courant ${runId}.`, author },
        }),
      ),
    );
    // 3. Brouillon (jamais publié : aucun snapshot) — aucune page.
    await withTransientNetworkRetry(() =>
      entries.create({
        contentType: 'article',
        routeNamespace: 'articles',
        title: `Draft Build Proof ${runId}`,
        slug: draftSlug,
        status: 'draft',
        data: validData,
        createdBy: admin.id,
        updatedBy: admin.id,
      }),
    );
    // 4. Publié puis soft-deleted — aucune page.
    await withTransientNetworkRetry(() =>
      entries.create(publishedRow({ slug: deletedSlug, publishedSlug: deletedSlug, deletedAt: new Date() })),
    );
    // 5. Dépublié (status draft mais snapshots historiques) — aucune page.
    await withTransientNetworkRetry(() =>
      entries.create(
        publishedRow({
          slug: `build-unpub-current-${runId}`,
          publishedSlug: unpublishedPublicSlug,
          status: 'draft',
        }),
      ),
    );
    // 6. Redirection vivante (cible = page publiée) → matérialisée.
    await withTransientNetworkRetry(() =>
      redirectsRepo.upsert({
        fromPath: `/articles/${redirectedFrom}`,
        toPath: `/articles/${publishedSlug}`,
        contentEntryId: null,
      }),
    );
    // 7. Redirection morte (cible = page dépublie) → NON matérialisée.
    await withTransientNetworkRetry(() =>
      redirectsRepo.upsert({
        fromPath: `/articles/${deadRedirectFrom}`,
        toPath: `/articles/${unpublishedPublicSlug}`,
        contentEntryId: null,
      }),
    );

    const build = runDemoBuild();
    expect(
      build.status,
      `build Astro échoué — sortie : ${(build.stderr ?? '').slice(-2000) || (build.stdout ?? '').slice(-2000)}`,
    ).toBe(0);

    // — 1. La vraie page statique est générée au format directory d'Astro.
    const pagePath = join(STATIC_ROOT, 'articles', publishedSlug, 'index.html');
    expect(existsSync(pagePath), `${pagePath} attendu`).toBe(true);
    expect(statSync(pagePath).size).toBeGreaterThan(0);
    const html = readFileSync(pagePath, 'utf8');
    expect(html).toContain(title);
    expect(html).toContain(excerpt);
    expect(html).toContain(`Par ${author}`);
    // Vrai template du Project (marqueurs propres à ArticleContent.astro).
    expect(html).toContain('Kreiz, application de démonstration');
    expect(html).not.toContain('brouillon (preview)');

    // — 1bis. Couverture publiée : <picture> responsive dans le HTML statique
    //         (mission §52/§53) — URLs WebP/AVIF, width/height, alt.
    expect(html).toContain('<picture>');
    expect(html).toContain('image/avif');
    expect(html).toContain('image/webp');
    expect(html).toContain(`${MEDIA_PUBLIC_BASE_URL}/media/${coverMediaId}/400.avif`);
    expect(html).toContain(`${MEDIA_PUBLIC_BASE_URL}/media/${coverMediaId}/400.webp`);
    expect(html).toContain(`${MEDIA_PUBLIC_BASE_URL}/media/${coverMediaId}/800.webp`);
    expect(html).toContain(`alt="${coverAlt}"`);
    expect(html).toContain('width="1000"');
    expect(html).toContain('height="500"');
    // Aucune URL d'original privé, aucune URL signée expirante (mission §53).
    expect(html).not.toContain(`/media/${coverMediaId}/original`);
    expect(html).not.toContain('X-Amz-Signature');

    // — 2. Slug dérivé : page à l'adresse publique figée, PAS au slug courant ;
    //      le contenu rendu est celui du snapshot (titre public).
    const driftPage = join(STATIC_ROOT, 'articles', driftPublicSlug, 'index.html');
    expect(existsSync(driftPage), `page au slug public ${driftPublicSlug} attendue`).toBe(true);
    expect(readFileSync(driftPage, 'utf8')).toContain(driftPublicTitle);
    expect(existsSync(join(STATIC_ROOT, 'articles', driftCurrentSlug))).toBe(false);

    // — 3/4/5. Exclusions : draft, soft-deleted, dépublié absents.
    expect(existsSync(join(STATIC_ROOT, 'articles', draftSlug))).toBe(false);
    expect(existsSync(join(STATIC_ROOT, 'articles', deletedSlug))).toBe(false);
    expect(existsSync(join(STATIC_ROOT, 'articles', unpublishedPublicSlug))).toBe(false);

    // — 6. Sortie Vercel réelle : la redirection vivante est une route 301
    //      (source, destination, statusCode) dans config.json (mission §47).
    const vercelConfig = JSON.parse(
      readFileSync(join(OUTPUT_ROOT, 'config.json'), 'utf8'),
    ) as { routes?: Array<Record<string, unknown>> };
    const routes = vercelConfig.routes ?? [];
    const redirectRoute = routes.find(
      (route) => JSON.stringify(route).includes(redirectedFrom) && JSON.stringify(route).includes(publishedSlug),
    );
    expect(redirectRoute, `route de redirection pour /articles/${redirectedFrom} attendue`).toBeTruthy();
    expect(JSON.stringify(redirectRoute)).toContain('301');
    // La source redirigée n'est PAS une page statique.
    expect(existsSync(join(STATIC_ROOT, 'articles', redirectedFrom))).toBe(false);
    // — 7. La redirection à cible morte n'est pas matérialisée.
    expect(JSON.stringify(routes)).not.toContain(deadRedirectFrom);
    // La table de routage n'embarque aucune page dynamique `articles` en SSR :
    // aucune route avec `dest` de fonction pour un slug prérendu.
    for (const route of routes) {
      const serialized = JSON.stringify(route);
      if (serialized.includes(publishedSlug)) continue; // la 301 ci-dessus
      expect(serialized, `route SSR inattendue : ${serialized}`).not.toContain('build-proof');
    }
    // Le contenu prérendu ne rentre jamais dans la fonction SSR : ni les
    // données, ni un slug qui n'est pas cible d'une redirection (le
    // manifeste de routage liste en revanche les routes de redirection —
    // métadonnée inerte, la redirection étant servie par config.json).
    for (const file of walkMjsFiles(join(OUTPUT_ROOT, 'functions'))) {
      const code = readFileSync(file, 'utf8');
      expect(code.includes(excerpt), `${file} contient le contenu prérendu`).toBe(false);
      expect(code.includes(`Par ${author}`), `${file} contient le contenu prérendu`).toBe(false);
      expect(code.includes(driftPublicSlug), `${file} contient le slug public dérivé`).toBe(false);
      expect(code.includes(draftSlug), `${file} contient le brouillon`).toBe(false);
      if (code.includes(publishedSlug)) {
        // Seule occurrence tolérée : la route de redirection vers ce slug.
        expect(code.includes(redirectedFrom), `${file} mentionne le slug hors redirection`).toBe(true);
      }
    }
  }, 300_000);

  it('un contenu publié avec data invalide fait échouer explicitement le build', async () => {
    // `excerpt` requis absent du snapshot : le lecteur lève
    // ContentDataCorruptedError pendant getStaticPaths — le build doit
    // échouer, jamais produire une page partielle silencieuse.
    await withTransientNetworkRetry(() =>
      entries.create(
        publishedRow({
          slug: invalidSlug,
          publishedSlug: invalidSlug,
          publishedData: { body: 'Corps sans accroche.', author: 'Auteure' },
        }),
      ),
    );

    const build = runDemoBuild();
    expect(build.status, 'le build doit échouer sur des données publiées invalides').not.toBe(0);
    const output = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;
    // Astro imprime le message de l'erreur de domaine (pas le nom de classe)
    // : message de ContentDataCorruptedError + frame resolveContentViewModel.
    expect(output).toContain('données du contenu');
    expect(output).toContain('invalides');
    expect(output).toContain('resolveContentViewModel');
    // Aucune page n'a été produite pour ce contenu.
    expect(existsSync(join(STATIC_ROOT, 'articles', invalidSlug))).toBe(false);
  }, 300_000);
});
