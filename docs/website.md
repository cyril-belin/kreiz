# Vitrine Kreiz — `apps/website`

> Le site officiel de Kreiz : une seule page statique qui présente le
> projet. Elle ne consomme **pas** `@kreiz/core` au runtime — ni base de
> données, ni endpoint, ni secret. GitHub Pages ne déploie qu'elle.

## Rôles des trois briques

| Brique | Rôle | Runtime |
|---|---|---|
| `packages/core` | le moteur éditorial (`@kreiz/core`) | SSR admin + build |
| `apps/demo` | le consommateur de référence, les E2E, la preuve | Neon + Vercel |
| `apps/website` | **la vitrine** — présente Kreiz | statique pur, zéro dépendance |

La vitrine ne doit jamais dépendre du Core, de la démo, d'une base ou d'un
secret : elle doit rester déployable telle quelle sur n'importe quel
hébergeur statique.

## Dépendances

Volontairement minuscules : `astro`, `tailwindcss` (+ plugin Vite),
`@fontsource-variable/fraunces` (police auto-hébergée) et `sharp` en
devDependency (optimisation d'images **au build** uniquement — rien n'est
embarqué côté client). Le build produit **zéro fichier JavaScript**.

## Build local

```sh
pnpm --filter @kreiz/website dev     # http://localhost:4322/ — landing à la racine
pnpm --filter @kreiz/website build   # sortie statique dans apps/website/dist
pnpm --filter @kreiz/website preview # sert le build (sous /kreiz/, comme Pages)
```

Le `base` ne s'applique qu'au **build** (`astro build` pose
`NODE_ENV=production`) : en dev, la landing est servie à la racine —
`http://localhost:4322/`. `astro preview`, lui, sert le build réel sous
`/kreiz/` — c'est le comportement attendu, il reflète GitHub Pages.

## Base path GitHub Pages

GitHub Pages sert le repo sous `https://<owner>.github.io/<repo>/`, ici
`https://cyril-belin.github.io/kreiz/`. La config vit dans
[`apps/website/astro.config.ts`](../apps/website/astro.config.ts) :

- `site: 'https://cyril-belin.github.io'`
- `base: '/kreiz'`

Astro préfixe automatiquement les assets (CSS, images, fonts). La page
dérive canonical/OG et liens internes de ces deux valeurs — **ne
concatène jamais le préfixe à la main**. Piège connu : en build,
`import.meta.env.BASE_URL` vaut `/kreiz` **sans slash final** (d'où la
normalisation dans `src/pages/index.astro`).

Tester le base path localement (plus proche de Pages que `astro dev`) :

```sh
pnpm --filter @kreiz/website build
mkdir -p /tmp/pages/kreiz && cp -R apps/website/dist/* /tmp/pages/kreiz/
cd /tmp/pages && python3 -m http.server 8923
# → http://localhost:8923/kreiz/
```

## Déploiement GitHub Pages

Workflow : [`.github/workflows/pages.yml`](../.github/workflows/pages.yml).
Sur push `main` (chemin `apps/website/**`) ou `workflow_dispatch` :
pnpm + Node 24 (cache), `pnpm install --frozen-lockfile`, build de la
seule vitrine, `upload-pages-artifact`, `deploy-pages`. Permissions
minimales (`contents: read`, `pages: write`, `id-token: write`), un seul
job de déploiement à la fois (`concurrency: pages`), **aucun secret**.

Prérequis unique (une fois, manuel) : repository GitHub → Settings →
Pages → **Source : GitHub Actions**.

## Domaine custom (futur)

1. `astro.config.ts` : `site: 'https://kreiz.dev'` (exemple) et
   `base: '/'`.
2. Ajouter le `CNAME` chez l'hébergeur DNS, puis le fichier `public/CNAME`
   contenant le domaine (GitHub Pages le lit automatiquement).
3. Canonical et OG suivent `site`/`base` — aucune autre modification.

## Contenu et actifs

- La capture du back-office (`src/assets/admin-dashboard.png`) est une
  prise réelle de la démo : compte `admin@kreiz.local`, URL fictive
  `demo.kreiz.dev`, aucune donnée réelle. Astro la compile en variantes
  WebP responsive au build.
- L'image Open Graph (`public/og.png`, 1200×630) est générée depuis
  l'identité de la vitrine (fond papier, Fraunces, accent rouille).
- Le favicon (`public/favicon.svg`) : « K » serif italique sur encre.

## Relation avec la démo

La vitrine **présente** Kreiz ; la démo **prouve** Kreiz. Le bouton
« Utiliser le template » pointe vers GitHub (le repo est marqué Template
Repository) ; « Lire la documentation » vers la documentation publique de la
vitrine (`/docs/`). Aucune route `/admin` n'existe sur la vitrine — l'admin
SSR appartient à la démo/production, pas à un hébergeur statique.

## Documentation publique (`/docs`)

La vitrine héberge la documentation publique — le premier contact, avant la
couche technique de `docs/` :

- 7 pages : `/docs/` (accueil), `start`, `concepts`, `ai` (prompt maître à
  copier), `customize`, `deploy`, `developer` (renvoi vers `docs/*.md` du
  dépôt) — sources dans `src/pages/docs/`, composants partagés dans
  `src/components/doc/`, layout dans `src/layouts/DocLayout.astro` ;
- même identité que la landing (tokens `global.css` : papier/encre/rouille,
  Fraunces), sommaire sticky desktop et accordéon `<details>` natif mobile ;
- le seul JavaScript est un petit script **inline** de copie de prompts
  (délégation d'événement) : le build n'émet toujours **aucun fichier JS**.
