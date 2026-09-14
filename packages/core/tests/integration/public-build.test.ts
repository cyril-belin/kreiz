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
import {
  describeIntegration,
  setupIntegration,
  withTransientNetworkRetry,
  type IntegrationHarness,
} from './helpers';

/**
 * Preuve du **chemin public build-time** (revue slice 3) — la chaîne complète
 *
 *   published entry en DB → build Astro → createContentReader → registre
 *   Project → validation JSONB → template .astro du Project → HTML statique
 *
 * exercée pour de vrai : le test crée des **fixtures directement en base**
 * (infrastructure de test uniquement — aucune logique Publish, slice 4),
 * lance le **vrai build** de `apps/demo` (adapter Vercel) et inspecte la
 * sortie `.vercel/output/`.
 *
 * Exclusions prouvées dans le même build : un `draft` et un contenu
 * soft-deleted ne produisent aucune page. Un contenu publié au `data`
 * invalide fait **échouer explicitement le build** (contrat du lecteur :
 * `ContentDataCorruptedError` dans `getStaticPaths`) — jamais de page
 * partielle silencieuse.
 *
 * Aucune donnée fictive ne reste en Neon : fixtures supprimées en
 * `afterAll`, 0 ligne résiduelle. Les artefacts de build (`static/articles`,
 * `static/guides`, `static/realisations`) sont retirés pour rendre à la
 * sortie son état « 0 page dynamique ».
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
const draftSlug = `build-proof-draft-${runId}`;
const deletedSlug = `build-proof-deleted-${runId}`;
const invalidSlug = `build-proof-invalid-${runId}`;
const title = `Article Build Proof ${runId}`;
const excerpt = `Accroche publique ${runId}`;
const author = `Auteure Build ${runId}`;

let harness: IntegrationHarness;
let entries: ReturnType<typeof createContentEntriesRepository>;
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
  // mêmes pages, même adapter Vercel, même résolution des templates que le
  // build de déploiement.
  return spawnSync(
    process.execPath,
    ['./node_modules/astro/bin/astro.mjs', 'build'],
    {
      cwd: DEMO_ROOT,
      env: {
        ...process.env,
        KREIZ_DATABASE_URL: databaseUrlForBuild(),
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

describeIntegration('chemin public build-time — published → build Astro → HTML statique', () => {
  beforeAll(async () => {
    // Le build du demo importe @kreiz/core depuis dist/ (comme le CI).
    if (!existsSync(CORE_DIST)) {
      throw new Error(
        `Build de apps/demo impossible : @kreiz/core n'est pas buildé (${CORE_DIST}). Exécuter « pnpm --filter @kreiz/core build ».`,
      );
    }
    harness = await setupIntegration();
    entries = createContentEntriesRepository(harness.db);
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
      harness.raw(sql`delete from kreiz_content_entries where slug like ${'build-proof-%'} and created_by = ${admin.id}`),
    );
    await harness.raw(sql`delete from kreiz_admin_users where email like ${emailPattern}`);
    // La sortie de build retrouve son état « 0 page dynamique » (artefacts
    // git-ignorés, régénérés au prochain build).
    for (const dir of ['articles', 'guides', 'realisations']) {
      rmSync(join(STATIC_ROOT, dir), { recursive: true, force: true });
    }
    await harness.close();
  }, 60_000);

  it('une fixture published valide produit la vraie page statique ; draft et supprimé sont exclus', async () => {
    const now = new Date();
    const validData = { excerpt, body: `Corps public ${runId}.`, author };

    // 1. Article publié valide — le sujet de la preuve.
    await withTransientNetworkRetry(() =>
      entries.create({
        contentType: 'article',
        routeNamespace: 'articles',
        title,
        slug: publishedSlug,
        status: 'published',
        publishedAt: now,
        data: validData,
        createdBy: admin.id,
        updatedBy: admin.id,
      }),
    );
    // 2. Brouillon — ne doit produire aucune page.
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
    // 3. Publié puis soft-deleted — ne doit produire aucune page.
    await withTransientNetworkRetry(() =>
      entries.create({
        contentType: 'article',
        routeNamespace: 'articles',
        title: `Deleted Build Proof ${runId}`,
        slug: deletedSlug,
        status: 'published',
        publishedAt: now,
        deletedAt: now,
        data: validData,
        createdBy: admin.id,
        updatedBy: admin.id,
      }),
    );

    const build = runDemoBuild();
    expect(
      build.status,
      `build Astro échoué — sortie : ${(build.stderr ?? '').slice(-2000) || (build.stdout ?? '').slice(-2000)}`,
    ).toBe(0);

    // La vraie page statique est générée au format directory d'Astro.
    const pagePath = join(STATIC_ROOT, 'articles', publishedSlug, 'index.html');
    expect(existsSync(pagePath), `${pagePath} attendu`).toBe(true);
    expect(statSync(pagePath).size).toBeGreaterThan(0);
    const html = readFileSync(pagePath, 'utf8');

    // Colonnes communes → HTML.
    expect(html).toContain(title);
    // data typé → HTML (excerpt + auteur rendus par le template Article).
    expect(html).toContain(excerpt);
    expect(html).toContain(`Par ${author}`);
    // Vrai template du Project (marqueurs propres à ArticleContent.astro —
    // les mêmes que la preview SSR asserte en E2E : même module, pas de
    // renderer parallèle).
    expect(html).toContain('Kreiz, application de démonstration');
    // Publié → pas de marqueur de brouillon.
    expect(html).not.toContain('brouillon (preview)');

    // Exclusions : draft et soft-deleted absents de la sortie statique.
    expect(existsSync(join(STATIC_ROOT, 'articles', draftSlug))).toBe(false);
    expect(existsSync(join(STATIC_ROOT, 'articles', deletedSlug))).toBe(false);
    expect(existsSync(join(STATIC_ROOT, 'articles', draftSlug, 'index.html'))).toBe(false);
    expect(existsSync(join(STATIC_ROOT, 'articles', deletedSlug, 'index.html'))).toBe(false);

    // La page vit dans la partie **statique**, pas dans la fonction SSR :
    // aucune route `articles` dans la table de routage Vercel (les pages
    // prérendues n'y figurent jamais) et le slug n'apparaît dans aucun
    // module du bundle SSR.
    const vercelConfig = JSON.parse(
      readFileSync(join(OUTPUT_ROOT, 'config.json'), 'utf8'),
    ) as { routes?: Array<{ src?: string }> };
    expect(JSON.stringify(vercelConfig.routes ?? [])).not.toContain('articles');
    for (const file of walkMjsFiles(join(OUTPUT_ROOT, 'functions'))) {
      expect(readFileSync(file, 'utf8').includes(publishedSlug), `${file} contient le slug`).toBe(false);
    }
  }, 300_000);

  it('un contenu publié avec data invalide fait échouer explicitement le build', async () => {
    // `excerpt` requis absent : le lecteur lève ContentDataCorruptedError
    // pendant getStaticPaths — le build doit échouer, jamais produire une
    // page partielle silencieuse.
    await withTransientNetworkRetry(() =>
      entries.create({
        contentType: 'article',
        routeNamespace: 'articles',
        title: `Invalid Build Proof ${runId}`,
        slug: invalidSlug,
        status: 'published',
        publishedAt: new Date(),
        data: { body: 'Corps sans accroche.', author: 'Auteure' },
        createdBy: admin.id,
        updatedBy: admin.id,
      }),
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
