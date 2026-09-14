# Slice 4 — Publication, dépublication, rebuild et redirects

Statut : **terminé — en attente de revue** · 2026-09-14 · Base `main = 35a60d2`

## Livré

- **Publish / Unpublish** — cycle complet `Save → DB uniquement` puis
  `Publish → état publié → rebuild demandé → site statique régénéré`.
- **Dernier état effectivement public** (snapshots `published_*`) — la
  distinction « état éditorial courant » / « version publique figée » qui
  rend le contrat **Save != Publish** vrai jusqu'au bout, y compris au
  prochain rebuild déclenché par un autre contenu.
- **`published_at` = date de première publication**, jamais réécrite.
- **Port `RebuildTrigger`** (`src/ports/rebuild.ts`) — le domaine ne connaît
  aucune plateforme ; **adapter Vercel de référence** (deploy hook) + noop
  « non configuré » ; résultat typé honnête : « rebuild *requested* », jamais
  « rebuild *succeeded* ».
- **Redirects automatiques de changement de slug publié** — 301, chaînes
  normalisées à l'écriture, boucles impossibles par construction, conflit
  d'occupation détecté avant toute écriture.
- **Matérialisation build-time des redirects** via la config native Astro
  (`redirects`), émise par l'intégration → sortie Vercel `config.json`
  vérifiée en test d'intégration.
- **Rebuild manuel** (`POST /admin/rebuild`) — même port, audit, reprise
  après échec.
- **UI** : panneau d'état de publication à l'édition (brouillon / publié /
  dépublié / modifications non publiées), boutons Publier / Dépublier /
  Relancer le déploiement, bandeaux de résultat honnêtes, badge « Non
  publié » au listing (calcul, pas d'état DB), panneau « Site public » au
  dashboard.
- **Suppression d'un publié → rebuild** ; brouillon jamais publié → aucun
  rebuild.
- Audit `content.published`, `content.unpublished`, `site.rebuild_requested`,
  `site.rebuild_failed`.
- Migration **possédée par `apps/demo`** (`0002`) + tests de migration
  rejoués sur PostgreSQL réel.

## Dépendances ajoutées

**Aucune.** Le deploy hook est un simple `fetch` natif ; aucun nouveau
paquet dans `packages/core` ni `apps/demo`.

## Sémantique Save vs Publish — la décision structurante du slice

La mission §5 offrait deux options. L'**option A** (édition d'un `published`
dans la même ligne, le site ne change qu'au « rebuild suivant ») est
rejetée après analyse : le **prochain** rebuild — déclenché par la
publication de n'importe quel autre contenu — aurait matérialisé les
modifications non publiées. Le contrat Save != Publish aurait été violé de
façon différée et invisible.

**Retenu (variante minimale de l'option B)** : deux projections sur la
**même ligne**, aucune table de versions :

```text
état éditorial courant   : title, slug, data, seo        (écrits par Save)
dernier état public figé : published_title, published_slug,
                           published_data, published_seo  (écrits par Publish)
+ status (draft|published), published_at                  (inchangés)
```

- **Save** : n'écrit que les colonnes courantes. Le lecteur public ne lit
  **que** les snapshots → un Save ne change jamais la sortie publique,
  même au prochain rebuild.
- **Publish** : valide l'état courant (titre + schéma strict du type), le
  fige dans les snapshots, bascule `status = published`, audite, demande le
  rebuild. Validation **avant** toute écriture (mission §4) : un contenu
  invalide échoue sans effet de bord.
- **Preview** : rend l'état **courant** — `Save → Preview` montre les
  dernières modifications (mission §30, invariant conservé).
- Ce n'est **pas** du versioning : deux états bornés, pas d'historique, pas
  de rollback (hors périmètre, mission §1).

## `published_at` (mission §6)

- Première publication : `published_at = now`.
- Republication (après édition ou après unpublish) : **jamais réécrite** —
  c'est la date de première publication. Testée en unitaire et sur Neon.

## « Dernier état public » — mécanisme (mission §19-§20)

`published_slug` est la source fiable du dernier chemin réellement
public : le slug éditorial peut avoir dérivé (1, 2, n Saves) sans
publication — la redirection est créée depuis `published_slug`, jamais
depuis une hypothèse sur l'« ancienne ligne ». Conséquences :

- le build génère la page à `published_slug` uniquement (un slug courant
  dérivé ne résout aucune URL publique) ;
- l'indicateur « modifications non publiées » du listing est un **calcul**
  (comparaison snapshots ⇄ courantes), pas un état DB supplémentaire
  (mission §29).

## RebuildTrigger — architecture (mission §8-§10)

```text
services/content.ts (delete publié)  ┐
services/publication.ts (publish,    ├─→ ports/rebuild.ts : RebuildTrigger
                          unpublish, │       requestRebuild({ reason })
                          manual)    ┘     → { ok: true, requestId } |
                                            { ok: false, failure:
                                              not-configured | unreachable
                                              | rejected }
adapters/vercel/rebuild.ts : createVercelDeployHookTrigger({ hookUrl,
                              allowInsecureHttp }) — POST deploy hook.
```

- Câblage runtime : `KREIZ_REBUILD_DEPLOY_HOOK_URL` (optionnelle) validée
  dans `http/server-env.ts` ; hook absent → `createNoopRebuildTrigger()`
  (`not-configured`), hook présent → adapter Vercel. **HTTPS imposé en
  production** ; `http://127.0.0.1` autorisé explicitement en dev/test.
- La distinction demandée par la mission est un résultat de première
  classe : *absence d'adapter* (état normal signalé à l'admin, publication
  réussie) ≠ *adapter configuré* ≠ *erreur temporaire*.
- Secret : l'URL vient de l'env runtime uniquement, jamais logguée, jamais
  rendue, jamais acceptée d'une saisie admin, jamais incluse dans un
  message d'erreur ou un audit (échec = `kind` + statut HTTP).
- Config sérialisable vs adapter runtime : aucune fonction dans le module
  virtuel — le canal de configuration est l'environnement, comme la base
  (mission §38).

## Échec du rebuild — stratégie (mission §11-§12, §40-§41)

Modèle assumé et documenté :

```text
DB = source éditoriale       site public = dernier build valide
```

- Le trigger **après** le commit DB (jamais avant — incohérence inverse) ;
  échec du trigger → la DB reste publiée, le dernier déploiement valide
  reste servi, l'échec est audité `site.rebuild_failed` et remonté à
  l'admin avec le bouton **Relancer le déploiement** (même port ; audit
  `site.rebuild_requested`).
- **Pas de rollback** fragile, pas de transaction distribuée simulée.
- Le vocabulaire est honnête : `rebuild requested` (un 202/200 d'un deploy
  hook n'est pas un build réussi) — jamais « rebuild succeeded ».
- Hors périmètre (volontairement) : polling, webhook de completion,
  dashboard de déploiements, queue durable.

## Transaction DB — vérification réelle (mission §32)

Prouvé sur le driver installé : `drizzle-orm/neon-http@0.45.2` lève
`"No transactions support in neon-http driver"` — **aucune transaction
interactive** sur le chemin canonique Neon HTTP. Décision : écritures
**séquentielles ordonnées à point de bascule unique**, séquencées par le
service de publication :

```text
1. delete  redirects WHERE from_path = nouveau chemin   (inoffensif seul)
2. upsert  redirects ancien chemin → nouveau            (inoffensif seul)
3. retarget redirects to_path = ancien → nouveau        (inoffensif seul)
4. UPDATE contenu → status/snapshots  ← POINT DE BASCULE (atomique SQL)
5. audit
```

Tout crash entre 1 et 3 laisse une redirection simplement non matérialisée
au build (cible non publiée → filtrée) ; **republier répare**. Aucun état
cassé possible.

## Redirect engine (mission §17-§26)

Règles pures dans `domain/content/redirect-engine.ts`, aucun I/O :

- **Plan d'écriture** (`planSlugChangeRedirect`) — uniquement si le slug
  **public** change (`published_slug ≠ slug`, mission §18 : un draft
  n'a aucune URL historique) :
  1. supprimer les redirections **sources** dont `from_path` est le
     nouveau chemin (« slug réapparu » — le chemin redevient une page) ;
  2. upsert `ancien → nouveau` (unicité `from_path`, ownership
     `content_entry_id`) ;
  3. **re-cibler** les lignes dont la cible est l'ancien chemin
     (`/a → /b` puis `/b → /c` donne `/a → /c` et `/b → /c` ;
     triple chaîne incluse).
- **Boucles impossibles par construction** (mission §22) : après l'étape 1,
  la cible n'est source d'aucune ligne ; tout cycle exigerait une arête
  sortante de la cible. Cas `a → b → c → a` testé (l'étape 1 casse le
  cycle) ; auto-redirection gardée par `RedirectSelfPathError`.
- **Conflit d'occupation** : si l'ancien chemin public est le chemin vivant
  d'un **autre** contenu actif (état atteignable hors bande), la publication
  échoue avant toute écriture (`PublishedPathOccupiedError`, cadrage §12
  « conflit détecté »).
- **Matérialisation build** (`materializableRedirects`) : seules les
  redirections dont la cible est un chemin publié vivant sont émises — une
  cible dépubliée ne masque pas un 404 honnête ; garde-fous défensifs :
  source non vivante (une vraie page ne redirecte jamais), terminalité,
  parsabilité. Statut **301 permanent** (mission §26).

## Résolution des redirects côté public (mission §25, §47)

**Config de build, jamais SSR** : l'intégration du Core, à
`astro:config:setup`, si `KREIZ_DATABASE_URL` est présent, lit les
redirections matérialisables et les injecte dans la config **native
Astro** (`redirects: { source: { destination, status: 301 } }`). L'adapter
Vercel les matérialise en `.vercel/output/config.json` — prouvé en
intégration sur un vrai build (source, destination, `301`), la source
n'existant pas comme page statique. Sans base (PR de fork) : aucune
redirection injectée, rien n'échoue. L'abstraction reste portable (carte
de build Astro, pas du Vercel brut) ; une base injoignable échoue
explicitement (le lecteur public échouerait de toute façon) — on
n'expédie jamais un build silencieusement privé de ses redirections.

## Suppression d'un publié (mission §31)

- Brouillon jamais publié → soft delete, **aucun rebuild**.
- Contenu `published` → soft delete + audit `content.deleted` + **rebuild**
  (sa page est dans le dernier build valide — elle doit en sortir).
- Dépublié puis supprimé → aucun rebuild (page déjà retirée par le rebuild
  de l'unpublish).
- Pas de redirect automatique vers l'accueil ; l'URL devient 404 après
  rebuild, sauf redirection historique existante (cible morte → non
  matérialisée).

## Routes admin (mission §42 — invariants conservés)

```text
POST  /admin/content/[type]/[id]/publish     GET sans effet (303 retour)
POST  /admin/content/[type]/[id]/unpublish   GET sans effet
POST  /admin/rebuild                         GET sans effet (dashboard)
```

Même socle que le delete du slice 3 : guard de session
(`resolveAdminAccess`), CSRF lié à la session, same-site/Fetch Metadata,
`checkOrigin` natif, en-têtes admin. Toutes sous `/admin/*` (cookie
`Path=/admin`, garde mécanique `admin-routes.test.ts` étendue aux 12
patterns). `return_to` de `/admin/rebuild` restreint à `^/admin(/|$)`.

## UI (mission §28-§30, §48)

- **Édition** : panneau d'état (Brouillon / Publié / Dépublié + adresse
  publique + date de première publication) ; boutons Preview · Publier
  (« Publier les modifications » si publié) · Dépublier · Supprimer ;
  bandeaux de résultat distinguant rebuild `ok` / `failed` /
  `unconfigured` ; aide sous le slug signalant la future redirection 301 ;
  libellé de sauvegarde explicite (« Enregistrer (sans publier) » sur un
  publié, bandeau « Modifications enregistrées — non publiées »).
- **Listing** : badge « Non publié » (pointillé) calculé par
  `hasUnpublishedChanges` — aucun état DB ajouté.
- **Dashboard** : panneau « Site public » — état du moteur de rebuild
  (configuré / non configuré, expliqué), bouton « Reconstruire le site »,
  bandeaux de résultat.
- Responsive vérifié en Chromium réel à 1440 / 1024 / 768 / 390 (0 px
  d'overflow, voir Validations) ; nouveaux blocs réutilisant les motifs
  CSS existants (`kz-banner`, `kz-badge`, `kz-panel`) + variantes
  (`--warning`, `--changed`) et `.kz-publication-state`.

## Audit (mission §16)

- `content.published` — `{ contentType, routeNamespace, slug,
  previousSlug?, redirectCreated? }` ;
- `content.unpublished` — `{ contentType, routeNamespace, slug,
  publishedSlug }` ;
- `site.rebuild_requested` — `{ reason, source: 'admin', outcome }`
  (rebuild manuel) ;
- `site.rebuild_failed` — `{ operation, failure: kind, statusCode? }` —
  acteur = l'admin ayant déclenché l'opération (invariant d'honnêteté du
  slice 2). **Jamais** l'URL du hook, jamais la réponse brute du provider.
- Pas d'événement `site.rebuild_requested` systématique après chaque
  publication : `content.published` trace déjà l'action ; seule la
  **demande manuelle** et l'**échec** ajoutent une trace utile.

## Migration (mission §51)

- `apps/demo/drizzle/0002_shallow_lightspeed.sql` : 4 colonnes nullable
  (`published_slug`, `published_title`, `published_data`, `published_seo`)
  — `null` = jamais publié ; Publish est l'unique écrivain.
- Le Core ne possède toujours **aucune** migration (garde testée).
- Test de migration rejouant `0000 → 0001 → 0002` dans un schéma isolé sur
  PostgreSQL réel : colonnes absentes à l'état slice 1, présentes et
  nullables après 0002, lignes préexistantes lisibles (snapshots NULL).
- Aucune donnée système cachée dans `seo` ou `data` (mission §51) : les
  snapshots ont leurs colonnes propres.

## Sécurité (mission §49) — re-vérifications

- URL de deploy hook : env runtime, HTTPS en production, jamais dans le
  HTML (asserté en E2E sur l'écran d'échec), jamais logguée, jamais dans
  les métadonnées d'audit (asserté : `127.0.0.1:43990` absent), jamais
  fournie par l'admin.
- `KREIZ_SECRET`, Neon URL, secrets CI : inchangés ; le workflow ne
  génère aucun nouveau secret dynamique (le hook E2E est un URL localhost
  constant, non secret).

## Tests

- **Unitaires** (`packages/core/tests/`) :
  - `redirect-engine.test.ts` (13) : chemins, plan simple, normalisation
    `/a→/b→/c` et triple, retour au slug initial (boucle cassée), cycle
    long, auto-redirection refusée, matérialisation (cible vivante, cible
    morte, source vivante, chaîne résiduelle, parsabilité), config Astro
    déterministe ;
  - `publication-service.test.ts` (20, doubles en mémoire) : première
    publication (snapshots, audit, rebuild), validation avant écriture,
    Save != Publish (snapshots intacts par un Save, indicateur), `published_at`
    non réécrit, unpublish (historique conservé, no-op sur draft),
    redirect 301 + ownership, pas de redirect draft, chaîne normalisée,
    slug réapparu, conflit d'occupation avant toute écriture, source
    fiable `published_slug` (éditions multiples avant publish),
    not-configured (pas d'audit d'échec), échec trigger (DB reste
    publiée, audit sans secret), rebuild manuel, idempotence ;
  - `vercel-rebuild.test.ts` (9, serveur HTTP local) : 200/202 → ok,
    503 → `rejected` sans fuite de la réponse, connexion coupée →
    `unreachable`, HTTPS imposé hors dev, URL jamais dans les résultats ;
  - `rebuild-config.test.ts` (6) : env optionnelle, câblage runtime,
    noop ;
  - `content-service.test.ts` étendu : delete publié → rebuild, delete
    draft → aucun, échec trigger après suppression ;
  - `admin-routes.test.ts` : garde étendue aux 3 nouvelles routes.
- **Intégration Neon** — **70/70** :
  - `publication.test.ts` (10) : publish persisté (snapshots, traçabilité,
    audit SQL), republication (snapshots mis à jour, `published_at`
    originel conservé), unpublish/republish (historique conservé),
    redirection chaîne normalisée en base réelle (upsert `from_path` +
    re-cible), slug réapparu (row supprimée, aucune boucle), conflit
    d'occupation (aucune écriture), course concurrentielle (23505 réelle
    de l'index unique partiel + double publish idempotent), delete
    publié/draft, corruption (ligne published sans snapshot → échec
    explicite du lecteur), projection publique (résolution au slug
    public uniquement, routes vivantes). Clé de type propre au run :
    le build démo du test public-build (parallèle sur la même base) ne
    lit que les `content_type` déclarés par le Project ;
  - `publication-migration.test.ts` (2) : chaîne `0000 → 0001 → 0002`
    rejouée en schéma isolé (voir Migration) ;
  - `public-build.test.ts` (2, scénarios regroupés sur un seul build
    réussi, mission §46) : publié → page au slug public avec le vrai
    template ; published au slug dérivé → page à l'adresse publique
    figée uniquement ; draft / soft-deleted / dépublié → aucune page ;
    redirection vivante → route **301 dans `config.json` Vercel** avec
    source sans page statique ; redirection à cible morte → **non**
    matérialisée ; contenu prérendu jamais dans le bundle SSR (seule
    exception tolérée : l'entrée de manifeste de la route de redirection,
    métadonnée inerte) ; build en échec explicite sur snapshot `data`
    invalide (`ContentDataCorruptedError`).
- **E2E Playwright** (`apps/demo/e2e/publication.spec.ts`, 8 parcours) —
  **serveur de deploy hook local contrôlé** (`rebuild-hook-server.ts`,
  démarré par le global-setup, URL passée au serveur dev) : aucun vrai
  Vercel (mission §45/§50) ; le fil complet admin → service → port →
  adapter → hook HTTP est exercé :
  1. Publish : bandeau + badge, DB (statut, snapshots, `published_at`),
     audit, hook `content.published` ;
  2. **Save != Publish** : bandeau « non publiées », DB séparant courant
     V2 / public V1, indicateur listing, preview = courant ;
  3. Publish des modifications → snapshot V2 + hook ;
  4. slug publié changé → redirect row (from/to/ownership) + snapshot
     suivi ;
  5. Unpublish : draft + historique conservé + audit + hook ;
  6. échec du rebuild (hook 503) : message clair, DB cohérente, audit
     sans secret, HTML sans l'URL du hook, bouton « Relancer le
     déploiement » → retry vert (hook `manual`) ;
  7. rebuild manuel dashboard : hook `manual`, audit
     `site.rebuild_requested` ;
  8. draft slug change → 0 redirect ; publish sans CSRF → 403, session
     intacte.

## CI (mission §50)

Structure inchangée (`quality` sans secrets, forks safe ; `integration`
gated, branche Neon éphémère, migrations, tests, E2E, cleanup
`if: always()`). La migration 0002 passe par l'étape `db:migrate`
existante ; l'E2E démarre le hook local (localhost, non secret) —
**aucun secret Vercel dans la CI open source**, aucun déploiement
externe.

## Décisions et compromis (récapitulatif)

1. **Snapshots `published_*` plutôt que l'option A** — l'option A fuit les
   modifications non publiées au prochain rebuild d'un autre contenu ;
   les snapshots réalisent exactement la distinction « état éditorial
   courant / dernier état public » de la mission §20. Pas de versioning
   (deux états bornés).
2. **Écritures séquentielles, pas de transaction** — le driver neon-http
   ne supporte pas de transaction interactive (prouvé) ; l'ordre à point
   de bascule unique rend tout crash intermédiaire inoffensif et
   réparable.
3. **Redirects = config de build Astro** (matérialisée Vercel) — pas de
   SSR pour les redirections ; abstraction portable ; fork-safe.
4. **`not-configured` est un résultat, pas une erreur** — un projet peut
   piloter son déploiement autrement ; l'UI l'explique.
5. **Conflit d'occupation = échec de publication explicite** — un
   redirect masquerait une vraie page ; l'admin corrige le slug.
6. **Redirect conservé à travers un cycle unpublish/republish** — l'URL
   historique a réellement été publique ; un 301 vers le contenu revenu
   est la sémantique la plus utile (cadrage : historique de navigation).
7. **Pas d'export public de l'adapter** — le canal de configuration V1
   est l'env ; un second provider justifiera une option de config
   dédiée (cadrage : pas d'abstraction sans besoin démontré).
8. **Lecture DB à `astro:config:setup`** pour les redirections — même
   compromis que le lecteur public au build ; sans URL, skip silencieux ;
   avec URL injoignable, échec explicite.

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc + astro check, 0 erreur) ·
  `pnpm test` ✅ (**220 tests unitaires**) · `pnpm build` ✅ (core + demo,
  adapter Vercel) · `pnpm test:integration` ✅ (**70/70** sur la branche
  Neon de développement) · E2E ✅ (**25/25**, dont 8 slice 4, contre
  serveur dev SSR + Neon + hook local).
- **Données résiduelles : 0** (entries `pub-%`/`build-%`, redirects,
  admins `it-%`, audits site comptés à 0 après intégration + E2E ;
  teardown E2E étendu aux redirections).
- Responsive : écran d'édition (panneau d'état, 4 boutons d'action),
  listing (double badge) et dashboard vérifiés en Chromium réel à
  **1440 / 1024 / 768 / 390** — 0 px d'overflow horizontal.

## État Git

Travail **non commité** (revue demandée avant validation) — base
`main = 35a60d2`, aucun historique réécrit, aucun push.
