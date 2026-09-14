import { RedirectSelfPathError } from './errors.js';

/**
 * Moteur de redirections de publication (cadrage §12, mission §17-§26) —
 * **règles pures, aucune I/O** : la collision et l'occupation réelles sont
 * vérifiées par le service de publication via les repositories ; ici,
 * uniquement la construction des chemins, le plan d'écriture normalisé et
 * la matérialisation build-time.
 *
 * Invariant de terminalité maintenu par le plan d'écriture : **aucune
 * redirection ne pointe vers une autre redirection** et **aucune redirection
 * n'a pour source le chemin vivant d'un contenu publié**. Il s'ensuit que
 * les boucles sont impossibles par construction (tout cycle exigerait une
 * arête sortante de la cible, qui n'en a jamais).
 */

/** Chemin public canonique d'un contenu : `/{namespace}/{slug}`. */
export function publicPath(routeNamespace: string, slug: string): string {
  return `/${routeNamespace}/${slug}`;
}

/** Forme minimale d'une ligne de redirection (lecture). */
export interface RedirectPathRow {
  readonly fromPath: string;
  readonly toPath: string;
}

/** Forme minimale d'un chemin publié vivant (namespace + slug). */
export interface PublishedRoute {
  readonly routeNamespace: string;
  readonly slug: string;
}

/**
 * Plan d'écriture d'une redirection de changement de slug publié —
 * **ordonné**, chaque étape est individuellement cohérente et le point de
 * bascule (la publication elle-même) reste atomique côté PostgreSQL :
 *
 * 1. `removeStaleSources` — lignes dont `from_path` est le **nouveau** chemin :
 *    le chemin redevient une vraie page, il ne doit plus rediriger
 *    (« slug réapparu », cadrage §12 — résolu par remplacement, jamais par
 *    une boucle) ;
 * 2. `upsert` — la redirection `(fromPath → toPath)` ; une ligne existante de
 *    même source est écrasée (upsert sur l'unicité `from_path`) ;
 * 3. `retargets` — lignes pointant vers l'**ancien** chemin public,
 *    re-ciblées vers le nouveau : les chaînes sont normalisées à l'écriture
 *    (`/a → /b` puis `/b → /c` donne `/a → /c` et `/b → /c`, mission §21).
 *
 * Preuve d'absence de boucle : après l'étape 1, la cible n'est source
 * d'aucune ligne ; l'étape 3 ne peut donc pas créer d'auto-redirection, et
 * aucun cycle ne peut exister sans arête sortante de la cible.
 */
export interface SlugChangeRedirectPlan {
  readonly fromPath: string;
  readonly toPath: string;
  readonly removeStaleSources: string[];
  readonly retargets: Array<{ fromPath: string; toPath: string }>;
}

/**
 * Planifie la redirection d'un changement de slug **publié** — l'ancien
 * chemin (`previousPublicSlug`) a réellement été public, le nouveau chemin
 * devient la page vivante. Lève `RedirectSelfPathError` si les slugs sont
 * identiques (l'appelant ne doit planifier que sur changement réel) — garde
 * défensive contre toute auto-redirection.
 */
export function planSlugChangeRedirect(input: {
  routeNamespace: string;
  /** Dernier slug effectivement public (`published_slug`) — jamais null ici. */
  previousPublicSlug: string;
  /** Slug éditorial courant, qui devient le chemin public à cette publication. */
  newSlug: string;
  /** État actuel de la table `kreiz_redirects` (lecture brute). */
  redirects: ReadonlyArray<RedirectPathRow>;
}): SlugChangeRedirectPlan {
  const fromPath = publicPath(input.routeNamespace, input.previousPublicSlug);
  const toPath = publicPath(input.routeNamespace, input.newSlug);
  if (fromPath === toPath) {
    throw new RedirectSelfPathError(fromPath);
  }

  // 1. Le chemin cible redevient une page : ses anciennes redirections
  //    sources meurent (sinon elles masqueraient la page ou créeraient un
  //    cycle — les deux formations d'une boucle possible).
  const removeStaleSources = input.redirects
    .filter((row) => row.fromPath === toPath)
    .map((row) => row.fromPath);

  // 2 + 3. La nouvelle redirection, puis la normalisation des chaînes :
  //    tout ce qui pointait vers l'ancien chemin public est re-ciblé vers le
  //    nouveau. Les lignes supprimées à l'étape 1 ne sont jamais re-ciblées
  //    (leur source est la nouvelle page vivante).
  const staleSources = new Set(removeStaleSources);
  const retargets = input.redirects
    .filter((row) => row.toPath === fromPath && !staleSources.has(row.fromPath))
    .map((row) => ({ fromPath: row.fromPath, toPath: toPath }));

  return { fromPath, toPath, removeStaleSources, retargets };
}

/** Redirection matérialisable au build — source, cible et statut permanent. */
export interface MaterializableRedirect {
  readonly source: string;
  readonly destination: string;
  /** Les redirections automatiques de changement de slug sont 301 (mission §26). */
  readonly status: 301;
}

/**
 * Sélectionne les redirections **matérialisables au build** (mission §25) :
 * seules les redirections dont la cible est le chemin vivant d'un contenu
 * publié sont émises. Une cible déployée hier mais dépubliée depuis ne
 * redirecte plus vers une page morte — le visiteur reçoit directement un
 * 404 honnête. Garde-fous défensifs (l'écriture les garantit déjà) :
 * source != cible, source non vivante (une vraie page ne redirecte jamais),
 * terminalité (une source qui est elle-même une cible de redirection est
 * exclue), source parsable comme chemin public.
 */
export function materializableRedirects(
  redirects: ReadonlyArray<RedirectPathRow>,
  publishedRoutes: ReadonlyArray<PublishedRoute>,
): MaterializableRedirect[] {
  const livePaths = new Set(
    publishedRoutes.map((route) => publicPath(route.routeNamespace, route.slug)),
  );
  const sources = new Set(redirects.map((row) => row.fromPath));

  const materializable: MaterializableRedirect[] = [];
  for (const row of redirects) {
    if (row.fromPath === row.toPath) continue;
    if (!livePaths.has(row.toPath)) continue;
    if (livePaths.has(row.fromPath)) continue;
    if (sources.has(row.toPath)) continue;
    if (!isPublicPath(row.fromPath)) continue;
    materializable.push({ source: row.fromPath, destination: row.toPath, status: 301 });
  }
  // Ordre déterministe (assertions de build stables).
  materializable.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return materializable;
}

/** `/{namespace}/{slug}` — deux segments non vides, pas de `..`, pas de `/` internes. */
function isPublicPath(path: string): boolean {
  if (!path.startsWith('/') || path.endsWith('/')) return false;
  const segments = path.slice(1).split('/');
  if (segments.length !== 2) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Configuration `redirects` d'Astro (mission §25 — config de build, pas SSR). */
export type AstroRedirectConfig = Record<string, { destination: string; status: 301 }>;

/** Convertit les redirections matérialisables en configuration Astro. */
export function astroRedirectsConfig(
  materializable: ReadonlyArray<MaterializableRedirect>,
): AstroRedirectConfig {
  const config: AstroRedirectConfig = {};
  for (const redirect of materializable) {
    config[redirect.source] = { destination: redirect.destination, status: redirect.status };
  }
  return config;
}
