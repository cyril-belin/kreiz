# Slice 5 — Médias

Statut : **terminé — en attente de revue** · 2026-09-15 · Base `main = c1c0ff5`

## Livré

- **Upload direct navigateur → stockage objet** (mission §3) : le fichier image ne
  transite **jamais** par le serveur Astro — demande d'URL présignée authentifiée, PUT
  direct navigateur → stockage, confirmation serveur avec vérification de l'objet **réel**.
- **Trois ports** (mission §7/§12/§17) — `ObjectStorage`, `ImageTransformer`,
  `BackgroundJobs` : le domaine média ne connaît ni SDK AWS/R2/MinIO, ni Sharp, ni
  `waitUntil`.
- **Adapter S3-compatible de référence** (R2 / S3 / MinIO, style *path*) avec signature
  AWS Signature Version 4 **implémentée en interne** (`adapters/storage/sigv4.ts`, ~200
  lignes, zéro dépendance) — prouvée contre les **vecteurs officiels AWS** et, pour la
  forme HTTP, contre un vrai serveur S3 local (s3rver).
- **Adapter Sharp de référence** (mission §13) : variantes 400/800/1400/2000 px en WebP +
  AVIF, ratio conservé, **pas d'upscale**, orientation EXIF corrigée, métadonnées
  nettoyées, bombe à la décompression refusée (`limitInputPixels`).
- **Lifecycle explicite** `uploading → processing → ready | failed` gardé **en SQL**
  (`UPDATE … WHERE status IN (…)`), confirmations idempotentes, retry admin, services de
  récupération (`retryFailedMedia`, `processStuckMedia`) pour un cron futur.
- **Médiathèque** `/admin/media` (mission §32) : grille, upload avec progression
  0–100 % et polling de statut (îlot **vanilla JS** ciblé — mission §33 « island Vue ou
  JS »), alt text, retry, suppression protégée.
- **Couverture de contenu** (mission §27) : champ système `cover_media_id` activé dans
  les formulaires (sélecteur HTML progressif des médias `ready`), jamais dans `data`.
- **Snapshot public de couverture** `published_cover_media_id` (mission §28) : Save !=
  Publish vaut pour les images — un changement de couverture non publié ne fuit jamais
  dans le rebuild d'un autre contenu.
- **Publication validée avant écriture** : une couverture référencée doit être `ready`
  (mission §29) ; le lecteur de build résout les couvertures en batch et échoue
  explicitement sur une divergence.
- **Vue publique média** (mission §30/§31) : view model stable (`alt`, `width`,
  `height`, `variants[]` triées) + helpers `<picture>` (srcset AVIF/WebP, `sizes` au
  choix du Project) — le template reste maître du layout ; nouveau sous-chemin public
  `@kreiz/core/media`.
- Audit `media.created / ready / failed / retried / alt_updated / deleted` avec
  l'**honnêteté d'acteur** du slice 2 (processing système = `actor_admin_id NULL` +
  `metadata.source`).
- Migration **possédée par `apps/demo`** (`0003`) + tests de migration rejoués sur
  PostgreSQL réel.

## Dépendances ajoutées

| Package | Version | Rôle |
|---|---|---|
| `sharp` | ^0.34.5 | Transformation d'images — dépendance de `@kreiz/core` **et** de `apps/demo` (même pattern que `drizzle-orm`/`@node-rs/argon2` : instance unique et tracé Vercel résolu depuis les `node_modules` de l'app) |
| `s3rver` | ^3.7.1 | **devDependency** (core + demo) — serveur S3 local réel pour les tests de l'adapter et l'upload direct E2E ; jamais embarquée, aucun credential |

**Pas de SDK AWS** : l'adapter S3 signe ses requêtes avec une implémentation SigV4
minimale confinée à `adapters/storage/sigv4.ts`. Motifs : arbre de dépendances lourd,
surface de supply chain, bundle serverless — pour quatre verbes et des clés générées dont
les caractères sont restreints par construction (l'adapter **refuse** toute clé exigeant
un encodage d'URL). La cryptographie est prouvée par les vecteurs AWS publiés ; le
comportement réseau par un serveur S3 réel local. Si un besoin réel (multipart, KMS…)
apparaissait, le port rend le remplacement indolore.

## Architecture

```text
Admin (/admin/media)
  1. POST /admin/media/upload-request   (session + CSRF en-tête + same-origin)
     → validation métadonnées (mime allowlist, ≤ 20 Mo) — 1er filtre seulement
     → row media `uploading`, clé générée media/{id}/original
     → présignature PUT (10 min, une clé exacte, content-type figé)
  2. navigateur → PUT direct → ObjectStorage (R2/S3/MinIO)   [progression 0-100 %]
  3. POST /admin/media/[id]/confirm
     → head + lecture objet réel : taille, magic bytes (jamais le navigateur)
     → uploading → processing (transition gardée SQL) → enqueue
  4. BackgroundJobs (waitUntil Vercel / fire-and-forget dev)
     → MediaProcessingService → ImageTransformer (Sharp)
     → variantes écrites (Cache-Control: public, max-age=31536000, immutable)
     → processing → ready + audit (acteur NULL, source background_job)
```

- `domain/media/` — règles pures sans I/O : `policy` (20 Mo, allowlist
  jpeg/png/webp/avif — **pas de SVG**, 30 MP anti-bombe, alt ≤ 1 000), `keys` (clés
  générées `media/{id}/original` et `media/{id}/{width}.{ext}` — jamais le nom
  utilisateur, traversal/caractères spéciaux refusés par construction), `lifecycle`
  (machine à états, `ready` terminal), `inspect` (magic bytes jpeg/png/webp/avif —
  l'extension n'est jamais une preuve), `view-model` (vue publique, `ready` uniquement),
  `picture` (srcset AVIF/WebP, fallback = plus grande WebP), `errors`.
- `services/` — `media-upload` (validation initiale, présignature, confirmation),
  `media-processing` (transformation, variantes, états), `media-admin` (listing, alt,
  retry, suppression), `media-recovery` (`retryFailedMedia`, `processStuckMedia`),
  `media-audit` (vocabulaire + sources).
- `data/repositories/media.ts` — primitives d'état gardées, `countCoverReferences`
  (couverture **courante OU snapshot**, contenus soft-deleted compris), suppression
  physique, balayages `findStuckProcessing`/`listFailed`. Pas de `BaseRepository`.
- `adapters/` — `storage/sigv4.ts` + `storage/s3.ts` (ObjectStorage), `image/sharp.ts`
  (ImageTransformer), `jobs.ts` (planificateurs `waitUntil` / fire-and-forget).
- `http/` — `server-env.ts` validant le bloc `KREIZ_STORAGE_*` (**tout ou rien**),
  `admin-runtime.ts` (services média `null` quand le stockage n'est pas configuré —
  état explicite à l'admin, jamais un service à moitié câblé ; port jobs **par
  requête** via `createMediaJobsForRequest`), `media-api.ts` (socle JSON : guard,
  CSRF en en-tête `x-kreiz-csrf-token`, same-site).

## Décisions et compromis (récapitulatif)

1. **Taille 20 Mo vérifiée deux fois** (mission §4) : métadonnées annoncées = filtrage
   anticipé ; seule la vérification de l'objet réel décide (`head` + lecture). Dépassement
   → refus + **objet supprimé du stockage** + média `failed` (`too-large`) + audit.
   Confirm sans objet présent → `object-missing`, état `uploading` conservé (l'upload est
   peut-être en cours — le client peut re-confirmer).
2. **AVIF accepté en entrée** (mission §5) : Sharp le décode proprement ; le type réel
   est relu par magic bytes. **SVG exclu** — vecteur actif (script embarqué, XXE) sans
   besoin démontré en V1.
3. **Durée de présignature : 10 minutes** (mission §9 : fourchette 5–15), `host;
   content-type` signés — le navigateur doit envoyer exactement le content-type signé
   (403 du stockage sinon), aucun droit général (pas de list, pas de delete, pas de
   lecture), clé exacte uniquement.
4. **Original privé, variantes publiques** (mission §42/§43) : l'original n'a pas de
   `publicUrl` dans le port, n'apparaît jamais dans un HTML ni dans la vue publique ;
   conservé pour retraitement futur. Recommandation projet documentée : policy bucket
   interdisant `GET /media/*/original` côté provider si le bucket public sert tout le
   préfixe.
5. **Clés immuables** (mission §40) : les variantes portent `Cache-Control: public,
   max-age=31536000, immutable`. Un retry réécrit les mêmes clés **seulement** tant que
   le média n'a jamais été `ready` (donc jamais servi — aucun cache à casser) ; `ready`
   est terminal, un média publié n'est jamais retransformé.
6. **Quality WebP 80 / AVIF 50** (mission §14) : bon ratio qualité/poids sans
   sur-optimisation, temps de transformation raisonnables en lambda. L'AVIF est rapporté
   `heif` par Sharp (conteneur ISO-BMFF) — la preuve du type réel passe par les magic
   bytes (`ftyp avif`).
7. **Pas d'upscale** (mission §13) : une variante dont la largeur dépasse la source
   n'est **pas produite** (pas de fichier dupliqué à taille identique) — le filtrage est
   dans l'adapter transformer, le service reçoit uniquement ce qui existe.
8. **Idempotence par transition gardée SQL** (mission §11) : `markProcessing` /
   `markReady` / `markFailed` filtrent sur le statut source — sous double confirm ou
   double job concurrent, une seule écriture gagne, l'autre est interprétée comme succès
   idempotent (`already-processing` / `already-ready`). Un second confirm sur
   `processing`/`ready` répond 202 sans ré-enfiler.
9. **`waitUntil` confiné à l'adapter** (mission §18) : le port jobs est composé **par
   requête** (`createMediaJobsForRequest`) — `waitUntil` quand la plateforme l'expose,
   fire-and-forget sur un serveur long-lived (dev) où la promesse survit à la réponse.
   La requête confirm répond toujours vite ; `await sharp(...)` n'existe nulle part dans
   le chemin utilisateur. Pas de file durable en V1 : `processStuckMedia` (seuil par
   défaut 1 h) et `retryFailedMedia` sont des services appelables par un cron futur
   (mission §20) — pas de scheduler livré.
10. **Échec partiel de transformation** (mission §23) : variantes écrites puis échec →
    média `failed` (`variant-write-failed`) ; les objets résiduels n'ont jamais été
    publics (média jamais `ready`). Raisons courtes et stables en `failure_reason`
    (`too-large`, `mime-unsupported`, `transform-failed`, …) — **jamais de stack trace
    en DB** (mission §21).
11. **Suppression : utilisée = refusée, libre = physique** (mission §26/§46) : le
    comptage regarde `cover_media_id` **et** `published_cover_media_id`, y compris les
    contenus soft-deleted — l'historique prime. Un média libre est supprimé
    physiquement (ligne + original + variantes), ordre DB → storage (un objet orphelin
    est invisible et purgeable, un row orphelin ne l'est pas). La FK RESTRICT (23001)
    reste le garde-fou ultime, prouvé en intégration.
12. **Snapshot `published_cover_media_id`** (mission §28) : sans lui, le rebuild
    déclenché par *un autre* contenu aurait matérialisé une couverture non publiée —
    la même faille différée qui a imposé les snapshots slice 4. Migration `0003`
    (colonne nullable + FK RESTRICT) possédée par `apps/demo` ; Publish est l'unique
    écrivain ; le lecteur de build lit le snapshot, jamais l'état éditorial.
13. **Picker HTML progressif + îlot JS ciblé** (mission §32/§33) : la médiathèque
    concentre upload/alt/retry/delete ; l'îlot **vanilla** (mission autorise « island
    Vue ou JS ») couvre uniquement présignature → progression → polling, sans aucune
    dépendance framework imposée aux consommateurs du Core (un Core qui exigerait Vue
   forcerait chaque projet à l'installer). Le formulaire de contenu utilise un
    `<select>` des médias `ready` + aperçu serveur — fonctionne sans JS.
14. **`@kreiz/core/media`** : nouveau sous-chemin public (types de vue, helpers
    `<picture>`, politique, erreurs, lecteur de build). Les ports/adapters restent
    internes — le canal de configuration est l'environnement runtime, comme la base.
15. **SigV4 en interne** (voir Dépendances) : vecteurs AWS officiels comme garde
    cryptographique (`f0e8bdb8…` GET Object, `fea454ca…` GET Bucket Lifecycle),
    s3rver pour l'intégration HTTP. s3rver **ne recalcule pas** les signatures SigV4
    (authentification par access key) — d'où la complémentarité des deux niveaux.
16. **Sharp externe au bundle** (`ssr.external: ['sharp']`) comme Argon2 : binaire
    natif chargé depuis `node_modules`, tracé dans la fonction Vercel
    (`.vercel/output/functions/_render.func/node_modules/@img/sharp-*/lib/*.node`
    vérifié au build réel) ; la transformation n'a lieu **que** dans les jobs — le
    build public ne transforme jamais (les variantes sont déjà prêtes, le build lit
    seulement la DB).
17. **CORS bucket documenté, pas automatisé** (mission §38) : config de référence
    (§ infra) appliquée par le projet ; l'E2E l'applique à son bucket s3rver — aucune
    modification de bucket en production n'est tentée par le code.
18. **Env bloc `KREIZ_STORAGE_*` tout-ou-rien** : présenter une variable sans les
    autres est une erreur explicite de validation ; le bloc absent = fonctionnalités
    média désactivées proprement (panneau dédié dans l'admin, publications sans
    couverture inchangées).

## Routes admin (invariant `/admin/*` conservé — 19 patterns gardés par test)

```text
GET   /admin/media                        médiathèque (grille, upload, alt, retry, delete)
POST  /admin/media/upload-request         présignature — POST JSON, CSRF en en-tête (mission §37)
POST  /admin/media/[id]/confirm           confirmation post-upload — POST JSON
GET   /admin/media/[id]/status            polling — GET JSON
POST  /admin/media/[id]/alt               alt text — formulaire progressif
POST  /admin/media/[id]/retry             retry d'un failed — formulaire progressif
POST  /admin/media/[id]/delete            suppression protégée — formulaire progressif
```

Tous derrière le même socle slice 2/3 (guard `resolveAdminAccess`, CSRF lié à la
session, same-site/Fetch Metadata, en-têtes admin, cookie `Path=/admin`). **Aucun
endpoint public de présignature** (mission §37).

## CORS du bucket — config de référence (mission §38)

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://admin.example.com</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
  </CORSRule>
</CORSConfiguration>
```

R2 : dashboard → bucket → Settings → CORS policy (ou `wrangler r2 bucket cors`).
MinIO/S3 : `PutBucketCors`. Le domaine admin est le seul `AllowedOrigin` en production
(l'E2E utilise `*` sur son bucket local jetable). L'upload direct exige le `content-type`
figé par la signature — d'où `AllowedHeader: content-type`.

## Cache et immutabilité (mission §40)

- Clés générées par id média — jamais réécrites après `ready` (voir décision 5).
- Variantes servies avec `public, max-age=31536000, immutable` (posé à l'écriture).
- Base publique (`KREIZ_STORAGE_PUBLIC_BASE_URL`) = CDN/bucket public configuré côté
  serveur ; **aucune URL signée expirante** n'est construite pour le GET public
  (mission §39) et l'original n'a pas d'URL publique.

## Tests

- **Unitaires** (`packages/core/tests/`, 63 nouveaux) :
  - `media-domain.test.ts` (19) : bornes (20 Mo, allowlist sans SVG, 30 MP, alt), clés
    générées + refus traversal/espaces, machine à états (valides, `ready` terminal,
    raccourcis interdits), magic bytes (4 formats, texte maquillé, HEIC, buffer court),
    vue publique (tri, ratios, URLs, refus non-ready, normalisation base), helpers
    `<picture>` (AVIF puis WebP, srcset croissant, fallback = plus grande WebP) ;
  - `media-upload-service.test.ts` (9) : création `uploading` + clé générée + audit
    `media.created`, refus métadonnées sans effet de bord, confirm nominal (mime réel
    stocké, enqueue), objet absent conservé `uploading`, trop gros → objet supprimé +
    `failed` + audit `confirm`, fichier maquillé → `mime-unsupported`, idempotence
    double confirm (pas de double enqueue), confirm sur `failed` refusé, média inconnu ;
  - `media-processing-service.test.ts` (6) : variantes écrites avec `Cache-Control`
    immuable + `markReady` + audit acteur NULL, original absent, transformation en
    échec (raison courte, **pas de stack en DB**), idempotent sur `ready`, skip sur
    `uploading`, job obsolète/supprimé ;
  - `media-admin-service.test.ts` (11) : alt (trim, vide autorisé, audit), retry
    (transition + enqueue + audit, refus sur `ready`), suppression (libre → ligne +
    objets storage + audit ; référencée draft → `MediaInUseError` ; référencée par un
    contenu **soft-deleted** → refus ; snapshot publié → refus), récupération
    (`retryFailedMedia`, `processStuckMedia` avec seuil, acteur NULL `source:
    recovery`) ;
  - `storage-sigv4.test.ts` (5) : **vecteurs AWS officiels** (canonical request,
    hash intermédiaire `7344ae5b…`, signatures `f0e8bdb8…` et `fea454ca…`),
    en-têtes serveur signés, refus de clés dangereuses ;
  - `storage-s3.test.ts` (7, **s3rver réel**) : presign → PUT par `fetch` indépendant
    → head → read (bytes identiques), `head` absent = null, écriture variante +
    `publicUrl` + GET public non signé, `deleteMany` tolérant, refus de clés non
    sûres, contraintes d'URL présignée (algorithm, expiry, signed headers) ;
  - `image-transformer-sharp.test.ts` (6, **Sharp réel**) : variantes réelles
    WebP/AVIF (formats vérifiés par metadata **et** magic bytes), no upscale (900 px →
    400+800 seulement), orientation EXIF (portrait orienté 6 → paysage), metadata
    nettoyées (EXIF absent), fichier non image → erreur, bombe à la décompression
    (36 MP > limite) → refus ;
  - gardes étendues : `data-public-api` (`./media`), `admin-routes` (19 patterns).
- **Intégration Neon** (`tests/integration/`) — **80/80** :
  - `media.test.ts` (9) : createUploading/findById, **double markProcessing
    concurrent → une seule gagne**, markReady (variants JSONB persistés) + ready
    terminal, retry failed→processing réel, alt update, listings filtrés (statuts,
    soft-deleted), couverture contenu (FK réelle, **snapshot `published_cover_media_id`
    persisté**, RESTRICT 23001 en SQL direct, refus service `MediaInUseError`),
    audit média à acteur NULL lu en SQL, balayages stuck/failed, suppression physique
    d'un libre ;
  - `media-migration.test.ts` (1) : chaîne **0000 → 0001 → 0002 → 0003** rejouée en
    schéma isolé — colonne absente avant 0003, présente/nullable après, FK RESTRICT
    vérifiée en réel (23001) ;
  - `public-build.test.ts` étendu : média `ready` (3 variantes) + article publié avec
    couverture → **build Astro réel** → HTML statique contenant `<picture>`, URLs
    AVIF/WebP construites depuis la base publique, `alt`, `width`/`height` de
    l'original — et **ni** URL d'original **ni** URL signée ; fixtures nettoyées
    (0 résidu).
- **E2E Playwright** (`apps/demo/e2e/media.spec.ts`, 7 parcours) — contre **serveur S3
  local réel** (s3rver démarré par le global-setup, port fixe, CORS configuré) :
  1. upload direct complet : progression → polling → reload → carte `Prêt`, DB
     (status/width/height/mime/variantes **sans upscale**), miniature servie depuis la
     base publique, variante AVIF en GET 200, **aucune URL d'original dans le HTML**,
     audit `created` (acteur admin) → `ready` (**acteur NULL**) → `alt_updated` ;
  2. fichier maquillé (.png, bytes texte) → message de refus → carte `Échec`
     (`mime-unsupported`) → **Réessayer** audité (`media.retried`) → re-échec (pas de
     boucle) ;
  3. SVG refusé **avant** toute présignature, 0 ligne créée ;
  4. picker : deux médias `ready` → alts → création d'Article avec couverture A →
     `cover_media_id` persisté, `data` propre ;
  5. **Save != Publish couverture** : publish avec A → public = A → Save avec B →
     public = A, preview = B → Publish → public = B ;
  6. média `uploading` (état d'infrastructure) : absent du picker, visible « En
     attente » dans la médiathèque ;
  7. suppression : couverture utilisée → bandeau de refus explicite ; média libre →
     suppression + objet storage 404.
  Teardown étendu : audit média → médias (par admins e2e) → contenus → admins →
  serveurs (hook + S3) — **0 résidu vérifié**.

## CI

Structure inchangée : `quality` (lint · build · typecheck · unit — dont les tests
s3rver/Sharp, locaux et sans secrets) ; `integration` (branche Neon éphémère, migration
`0003` via l'étape `db:migrate` existante, tests d'intégration, E2E, cleanup
`if: always()`). **Aucun credential R2/S3** : l'E2E et les tests storage utilisent
s3rver avec les credentials de test publics embarqués (`S3RVER`/`S3RVER`, serveur
localhost jetable — rien à masquer). Compatibilité forks conservée (job `quality`
autonome).

## Auto-revue hostile pré-commit — risques trouvés (tous non bloquants)

1. **Ids non UUID → 22P02 brute** : `confirm`/`status` avec un id invalide dans l'URL
   (ou `cover_media_id=garbage` en POST de formulaire) levaient une erreur SQL brute
   (500 au lieu de 404/erreur de champ). **Corrigé** : garde de format à la frontière
   du repository (`findById`/`deletePhysical` → « introuvable »), prouvée en
   intégration sur PostgreSQL réel.
2. **TOCTOU présignature** : une URL présignée reste valide (10 min) après le confirm —
   un re-PUT sur la même clé pendant la transformation pourrait remplacer l'original
   validé par d'autres bytes. Surface **admin uniquement** ; le transformer
   (décodage Sharp) revalide la décodabilité, un contenu non-image finit `failed`.
   Mitigations futures si besoin : durée plus courte, versioning S3, ou rotation de
   clé au confirm. Accepté en V1.
3. **`seo.og_image_media_id` non couvert par le comptage d'usage** : référence
   **logique** dans le JSONB (pas de FK possible) — un média référencé uniquement
   comme image sociale serait supprimable. Le champ n'est pas encore exposé (SEO =
   slice 9) : le slice SEO devra étendre le comptage d'usage (requête JSONB) au
   moment d'introduire la sélection d'image sociale.
4. **Endpoint S3 en HTTP toléré en production** (contrairement au deploy hook) :
   l'endpoint est une URL de service non porteuse de secret dans l'URL ; décision
   documentée — un projet stricte peut imposer HTTPS à son niveau.

## Difficultés découvertes

1. **s3rver ne vérifie pas SigV4** (v3.7 : « Signature version 4 calculation is
   unimplemented » côté serveur, authentification par access key seule) — un test
   d'intégration seul aurait surestimé sa preuve. Réponse : les **vecteurs AWS
   officiels** prouvent la cryptographie, s3rver prouve la forme et l'intégration HTTP
   réelle (URL consommée par un client indépendant, CORS, 404s).
2. **AVIF = conteneur HEIF** : Sharp reporte `format: 'heif'` pour ses sorties AVIF —
   l'assertion du type réel passe par les magic bytes du domaine (`ftyp avif`), qui
   double la preuve de bout en bout (produit ⇄ détecté).
3. **`APIContext` n'expose pas `response`** (constat slice 3 confirmé) : les endpoints
   JSON médias portent les en-têtes admin sur chaque `Response` construite.
4. **Sharp/version : `withMetadata` n'accepte plus le bloc `gps`** dans ses types — le
   GPS voyage dans le bloc EXIF (IFD3) et part avec lui ; le test prouve l'absence
   d'EXIF après transformation.
5. **pnpm strict** : `s3rver` doit être devDependency **de `apps/demo`** (infra E2E)
   en plus du core (tests storage) — même logique que `pg` au slice 2.
6. **Le teardown E2E est un chemin critique** : un échec réseau transitoire Neon au
   nettoyage laissait des lignes résiduelles qui empoisonnaient les runs suivants
   (comptages de cartes faussés) — découvert en conditions réelles. Réponse : chaque
   étape de nettoyage rejoue les erreurs réseau transitoires, l'ordre respecte la FK
   RESTRICT (médias **après** contenus — la couverture, courante ou snapshot, lie
   `kreiz_content_entries` vers `kreiz_media`), et le comptage « avant » de l'helper
   d'upload est mesuré sur la grille elle-même.
7. **Astro dev met en cache les pages prérendues** : une republication ne change PAS
   le HTML servi en dev pour une URL déjà visitée (cache de rendu statique du serveur
   dev) — le flux « Publish → la page publique change » n'est donc **pas** asserté en
   E2E. La preuve du rendu public complet (snapshots → build → HTML responsive) est
   portée par le test d'intégration `public-build.test.ts` sur **build Astro réel**,
   qui reproduit exactement la production ; l'E2E prouve l'invariant éditorial en
   base (`cover_media_id` ≠ `published_cover_media_id` à chaque étape) et la preview
   SSR (rendue par requête).
8. **Sémantique de suppression alignée sur le §26** : après republication avec la
   couverture B, la couverture A (remplacée en courant **et** en snapshot) n'est plus
   référencée — sa suppression réussit, et c'est exact. L'E2E couvre les deux cas :
   référencé (B) → refus, remplacé (A) → suppression + 404 sur l'objet storage.

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc + astro check, 0 erreur) ·
  `pnpm test` ✅ (**283 tests unitaires**, dont s3rver et Sharp réels) ·
  `pnpm build` ✅ (core + demo + adapter Vercel : binaire `@img/sharp-*` tracé dans la
  fonction, 7 routes médias dans `config.json`).
- `pnpm test:integration` ✅ (**80/80** sur la branche Neon de développement,
  migration 0003 appliquée).
- E2E ✅ (**32/32**, dont 7 slice 5, contre serveur dev SSR + Neon + s3rver local) —
  upload direct navigateur prouvé de bout en bout.
- **Données résiduelles : 0** (médias/audits/contenus par admins e2e supprimés,
  répertoire temporaire du storage purgé).
- `docs/slices/slice-5.md` — ce document ; README et `.env.example` étendus
  (`KREIZ_STORAGE_*` + CORS de référence).

## État Git

Travail **non commité** (revue demandée avant validation) — base `main = c1c0ff5`,
aucun historique réécrit, aucun push.
