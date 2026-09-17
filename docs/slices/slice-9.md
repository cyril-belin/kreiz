# Slice 9 — SEO + durcissement associé

Statut : **terminé — en attente de revue**, 2026-09-16, base `main = faafffd` (« feat: add privacy-first analytics with static beacon and SQL dashboard »).

## Livré

- **SEO dérivé de données structurées, jamais de HTML arbitraire** — le modèle est typé (`KreizContentSeo` JSONB + `SeoSiteConfig` déclarée en code), validé (Zod strict, clés inconnues rejetées), versionnable (JSONB évolutif, **aucune migration**). Le Project déclare sa configuration SEO ; le Core résout et rend les balises publiques. Aucune balise `<meta>` n'est écrite à la main depuis du HTML libre dans la démo.
- **Ordre de résolution documenté et implémenté** (`domain/seo/resolve.ts`) : **défauts Project → valeurs dérivées du contenu → overrides SEO explicites**. L'override gagne toujours ; les valeurs dérivées (titre du contenu, accroche du Project, texte du rich text, couverture) comblent les absences ; les défauts Project ferment la chaîne. Rien n'est jamais rendu vide (un meta sans valeur n'est pas émis).
- **Save ≠ Publish prouvé** — le SEO vit dans la double projection existante (`seo` / `published_seo`) : un Save sur un contenu publié ne change jamais la head publique, même au prochain rebuild déclenché par un autre contenu. Revalidation stricte au Publish avant toute écriture (unitaire + intégration Neon + E2E).
- **Canonical stricte** — base fiable **exclusivement** depuis la configuration Project (`seo.siteUrl`, normalisée : http(s), sans query/fragment/slash final), **jamais** d'un `Host` client (aucune lecture de l'en-tête nulle part). Override : chemin interne (`/…`) ou URL absolue **même origine** (vérifiée au Save et au Publish, redoublée au rendu) ; `javascript:`/`data:`/CRLF/hostiles écartés par construction ; query et fragment systématiquement retirés ; slash final normalisé (racine préservée). Le canonical vient du **slug publié** — après drift, il pointe la nouvelle URL.
- **sitemap.xml + robots.txt générés par le Core** — routes **prérendues** (`/sitemap.xml`, `/robots.txt`, fichiers statiques au build, zéro runtime). Sitemap : contenus publiés, non supprimés et **indexables** seulement (noindex exclus en SQL), `lastmod = published_at` (fiable : les Saves ne la touchent pas), URLs dédupliquées, + chemins statiques déclarés du Project (`seo.sitemap.extraPaths`, validés). robots.txt : `User-agent: *` / `Allow: /` / `Disallow: /admin, /api` + ligne `Sitemap:` absolue quand la base est configurée. robots.txt n'est **pas** une protection : les routes privées restent gardées par session + `X-Robots-Tag`.
- **Image Open Graph via le pipeline média (slice 5)** — `seo.ogImageMediaId` = référence média stable (jamais d'URL S3 ni présignée). Publish exige `ready` + stockage public configuré (même contrat que la couverture) ; le lecteur de build résout les vues OG **batch** avec les couvertures (une divergence = `ContentDataCorruptedError`, jamais un rendu silencieux) ; `og:image:width/height` portés par la variante émise (plus grande WebP), `og:image:alt` = alt du média (omis si vide).
- **Finding historique `seo.og_image_media_id` non compté — corrigé** : `countSeoOgImageReferences` (JSONB `seo` et `published_seo`, soft-deleted compris, même politique que couverture/rich text) ajoutée au comptage `countContentReferences` du repository médias. La suppression d'un média référencé (courant **ou** snapshot publié) est refusée (`MediaInUseError`) ; après retrait de la référence **et** republication, elle redevient possible. Prouvé sur PostgreSQL réel.
- **Twitter/X minimal** — `twitter:card` (`summary_large_image` dès qu'une image existe, sinon `summary`) + `twitter:site` (handle configuré). **Aucune duplication** : title/description/image ne sont pas répétés, les plateformes retombent sur l'OG.
- **JSON-LD safe** — builders typés uniquement (`websiteJsonLd`, `organizationJsonLd`, `breadcrumbJsonLd`, `articleJsonLd`) : le Project ne fournit jamais un objet arbitraire. Sérialisation neutralisant `<` (donc `</script>`) et U+2028/2029 — tests hostiles. Émission par les templates du Project via `set:html`, figée au build.
- **Head publique déterministe** (`seoHeadTags`) — pure fonction : ordre fixe (title → description → robots → canonical → referrer → OG → Twitter), tout attribut échappé, aucun doublon, aucune valeur vide. `<meta name="referrer" content="strict-origin-when-cross-origin">` posé dans le head (seule garantie portable pour du statique — les en-têtes de réponse relèvent du CDN).
- **Preview toujours noindex** — le Core impose `noindex: true` à la vue passée au template : la résolution partagée produit `robots noindex` **et** l'absence de canonical/og:url ; l'en-tête `X-Robots-Tag` du socle admin reste la garantie mécanique.
- **Admin SEO minimal** — section SEO du formulaire d'édition : titre, description, override canonique, noindex, picker d'image OG (médias `ready` seulement), overrides OG title/description. Aucun score, aucune jauge. Validation **serveur** intégrale (le navigateur ne fait que l'UX) ; erreurs par champ (`seo_title`, `seo_description`, `seo_canonical`, `seo_og_image`, `seo_og_title`, `seo_og_description`).
- **og:type par type de contenu** — mapping simple laissé au Project (option de résolution `ogType`, ex. `article`) ; pas de moteur ontologique.
- **404 du demo** — page 404 du Project, noindex, sans canonical. (500 : le public est statique, pas de runtime à faire échouer ; les fonctions SSR admin gardent leurs headers/guards.)
- **Zéro JS public ajouté** — tout est généré au build (chaînes HTML, XML, texte) ; aucun provider externe, aucun fetch réseau.

## Configuration Project (`kreiz({ seo })` / `defineSeoSiteConfig`)

```ts
// apps/demo/src/seo.ts
export const seoSite = defineSeoSiteConfig({
  siteName: 'Kreiz demo',                       // requis
  siteUrl: 'https://demo.kreiz.example',        // requis — base canonique fiable
  titleTemplate: '%s | Kreiz demo',             // défaut : %s | siteName (exactement un %s)
  defaultDescription: '…',                      // défaut description
  defaultOgImageUrl: 'https://…/og.png',        // image OG de repli (URL absolue)
  twitterSite: '@handle',                       // ou URL twitter.com/x.com → normalisé
  locale: 'fr-FR',                              // og:locale
  organization: { name, url?, logoUrl? },       // JSON-LD Organization optionnel
  sitemap: { extraPaths: ['/', '/contact'] },   // pages statiques du Project
});
```

La même constante est passée à `kreiz({ seo })` (revalidation **idempotente** — la forme résolue repasse telle quelle dans le schéma) et aux helpers de résolution des templates. Fail fast au chargement de la config.

## Modèle de données

**Aucune migration.** Le JSONB `seo` / `published_seo` (posés au slice 3) reçoit de nouvelles clés plates (`ogTitle`, `ogDescription`, `noindex`, `nofollow`) — JSONB évolutif par conception, sans CHECK destructif ni backfill (le finding « pattern CHECK sans backfill » ne s'applique pas : pas de SQL modifié). `ogImageMediaId` reste une référence logique JSONB (pas de FK possible depuis un JSONB) — la garde est le comptage de références, exactement comme le rich text. Historique `0000 → 0005` inchangé et rejoué par la suite d'intégration existante.

Schéma validé (`domain/seo/content-seo.ts`) : `title` ≤ 120, `description` ≤ 300, `ogTitle` ≤ 120, `ogDescription` ≤ 300, `canonicalOverride` ≤ 2048 (chemin ou http(s)), `ogImageMediaId` (UUID), `noindex`/`nofollow` booléens — clés inconnues rejetées. Bornes « raisonnables sans score » : le title rendu par gabarit est écarté au-delà de 200 caractères (le titre brut borné reste servi) ; la description dérivée est tronquée **sur frontière de mot** à 300.

## Ordre de résolution (référence)

| Champ | Override SEO | Valeur dérivée | Défaut Project |
|---|---|---|---|
| `title` | `seo.title` (gabarit appliqué, jamais de double site name) | titre du contenu | — (siteName si vide) |
| `description` | `seo.description` | accroche du Project (option) → texte du 1er champ richText (plaintext, whitespace compacté) | `defaultDescription` |
| `canonical` | `seo.canonicalOverride` (chemin / même origine) | `siteUrl + /{namespace}/{published_slug}` | — (omise si noindex) |
| `og:image` | média `seo.ogImageMediaId` (`ready`) | couverture publiée | `defaultOgImageUrl` |
| `og:title` / `og:description` | `seo.ogTitle` / `seo.ogDescription` | title/description résolus | — |
| `robots` | `noindex` / `nofollow` | — | `index, follow` |
| `twitter` | — | card selon image, handle | `twitter:site` |

`noindex` ⇒ canonical et `og:url` omis (aucun signal contradictoire). Un override canonique invalide/étranger est **écarté** au rendu (défense en profondeur — la barrière normale est le Save/Publish).

## Snapshots

`markPublished` fige `published_seo = seo` (mécanisme slice 4 inchangé) **après** validation : schéma SEO revalidé (une corruption JSONB est refusée, jamais figée), image OG `ready` + servable, canonique même origine. Le lecteur de build lit `published_seo` uniquement ; `resolvePublishedProjection` échoue explicitement sur snapshot absent (déjà en place). `hasUnpublishedChanges` couvre le SEO (comparaison JSON des deux projections — stable car les deux sortent du même pipeline de normalisation).

## Sécurité (scénarios hostiles testés)

- canonical `javascript:`/`data:`/CRLF/malformée/**cross-origin** : refusées au Save, au Publish, et écartées au rendu (triple barrière) ;
- HTML/guillemets dans title/description/alt : échappés en attribut (`seoHeadTags`), jamais interprétés — `</title>` impossible par construction du même coup ;
- `</script>`/`<`/U+2028 dans les champs JSON-LD : neutralisés par `serializeJsonLd` (le JSON reste valide, le script ne casse pas) ;
- injection XML dans le sitemap (slug/chemin hostiles) : échappement `&<>"'` ; chemins `extraPaths` validés (ASCII visible, pas de `..`, pas de query) ;
- host spoofing : la base canonique ne lit jamais l'en-tête Host (aucun code ne le lit) ;
- OG media id invalide (non-UUID) : « média inexistant », jamais une erreur SQL ;
- métadonnées géantes/clés inconnues : rejetées par le schéma strict au Save (et au Publish) ;
- clé prototype/clés arbitraires dans le JSONB `seo` : `strictObject` rejette.

## Hardening associé

- **Admin** (SSR) : en-têtes déjà posés (slice 2/5) — `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Robots-Tag: noindex`, CSP `frame-ancestors 'none'`, XFO `DENY`, HSTS en prod. Inchangés.
- **Public statique** : les en-têtes HTTP relèvent du **déploiement** (CDN) — documenté comme passe production : `Referrer-Policy: strict-origin-when-cross-origin` (posé aussi en `<meta>` par `seoHeadTags`, cohérent avec l'analytics qui ne stocke que des domaines), `X-Content-Type-Options`, `Permissions-Policy` raisonnable, `frame-ancestors` via CSP, HSTS si HTTPS réel. La CSP du site public est celle **native d'Astro** déjà configurée par le demo (`astro.config.ts`, hashes scripts/styles, `img-src 'self' data:` — à compléter du domaine média CDN en production, env-dépendant, donc laissé au Project).
- **Duplicates** : slash final normalisé partout (canonical, sitemap), query/fragment retirés, preview/admin/api hors sitemap + `Disallow`, anciennes URLs hors sitemap (redirections à part, mission §25), canonical = slug publié.

## Performance

- Zéro JS public ajouté (0 octet — chaînes générées au build) ; aucun provider, aucun fetch.
- Head d'une page de contenu : ≈ 1,4 Ko brut (17 balises utiles, aucune vide), ~0,5 Ko gzip — mesuré sur la sortie déterministe de `seoHeadTags`.
- Sitemap : une requête SQL indexée au build (`listPublishedForSitemap`, publiés actifs non-noindex) ; fichier statique servi par CDN (`cache-control: public, max-age=3600`).
- Prix SEO par page au build : une résolution pure (aucune I/O) + vues média OG déjà batchées avec les couvertures (**aucune requête ajoutée** au build par page).

## Intégration / routes

- `@kreiz/core/seo` (nouveau point d'entrée public) : `defineSeoSiteConfig`, `resolveContentSeo` / `resolvePageSeo` / `resolveSeo`, `seoHeadTags`, builders JSON-LD + `jsonLdScriptTag`, `ogImageFromMediaView`, `richTextDocumentToPlainText`, constantes `SITEMAP_PATH`/`ROBOTS_PATH`. Ne sont pas exposés : repositories, routes, validation services, admin.
- Routes injectées : `/sitemap.xml`, `/robots.txt` (prérendues, listées dans `PUBLIC_ROUTE_PATTERNS` — garde mécanique `/admin` étendue, test mis à jour).
- Config : bloc `seo` de `kreiz()` revalidé par le même schéma Zod (`strictObject`), résolu (forme normalisée) dans le module virtuel.
- Runtime admin : `getKreizSeoSiteConfig()` (module virtuel) injecté aux services contenu/publication — jamais le module virtuel dans les services (testabilité préservée).

## Fichiers créés / modifiés

**Core — créés** : `src/domain/seo/{site-config,content-seo,resolve,description,head,jsonld,sitemap,robots,validate}.ts`, `src/seo/{index,public-sitemap,public-robots}.ts`, `src/admin/components/OgImagePicker.astro`.
**Core — modifiés** : `src/config.ts` (bloc `seo`), `src/integration.ts` (+2 routes prérendues), `src/http/admin-routes.ts` (+2 patterns publics gardés), `src/http/content-form.ts` (champs `seo_*` whitelistés), `src/http/admin-runtime.ts` (injection `seoSite`), `src/content/runtime.ts` (`getKreizSeoSiteConfig`), `src/content/reader.ts` (résolution OG batch stricte), `src/domain/content/view-model.ts` (`view.seoImage`), `src/data/tables/content-entries.ts` (type `KreizContentSeo` étendu), `src/data/repositories/content-entries.ts` (`updateDraft seo`, `listPublishedForSitemap`), `src/data/repositories/media.ts` (`countSeoOgImageReferences` + comptage total), `src/services/content.ts` (SEO au Save), `src/services/publication.ts` (SEO au Publish), `src/admin/pages/content/edit.astro` (section SEO), `src/admin/pages/preview.astro` (noindex imposé), `src/admin/styles/admin.css` (fieldset), `package.json` (export `./seo`).

**Démo** : `src/seo.ts` (config), `astro.config.ts` (`seo: seoSite`), 3 templates + `index` + `contact` + `merci` (head résolue + JSON-LD), `src/pages/404.astro` (noindex), `e2e/seo.spec.ts` (+8 tests, fichier d'état `.seo-state.json` nettoyé au teardown), `playwright.config.ts` (`KREIZ_SITE_URL`).

**Tests Core** : `tests/seo-{site-config,resolve,head,jsonld,sitemap-robots,description,content-service}.test.ts` (78 tests unitaires), `tests/integration/seo.test.ts` (5 tests Neon), `tests/integration/public-build.test.ts` (garde « zéro JS public » ajustée : le JSON-LD `application/ld+json` — des **données**, jamais du code exécutable — rejoint le beacon comme script toléré). Doubles mis à jour : `in-memory-content.ts`, `in-memory-media.ts` ; garde exports (`data-public-api.test.ts`) ; sélecteurs E2E existants resserrés (`{ name: 'Titre', exact: true }` — le formulaire contient désormais trois champs « Titre… »).

**Durcissement au passage** : `content-entries.findById` refuse les identifiants non-UUID (« introuvable », jamais une 22P02 brute) — un `/admin/preview/<garbage>` rend un 404 propre au lieu d'un 500 (même garde que le repository médias).

## Décisions

- **Aucune migration SQL** : JSONB évolutif + référence média logique gardée par comptage — la position « nouvelle colonne seulement si nécessaire » est tenue (elle ne l'est pas).
- **Canonical same-origin seulement** : un canonical cross-origin (syndication) est légitime mais rare et risqué depuis une UI ; le chemin interne couvre le cas courant. Documenté comme extension future possible.
- **noindex ⇒ canonical et og:url omis** : éviter les signaux contradictoires (noindex + canonical vers soi) ; une page hors index n'a pas besoin d'URL canonique.
- **Sitemap sans index** : V1 = un seul sitemap simple (mission §10) ; la limite 50 000 URLs du protocole est très loin des volumes visés.
- **`lastmod = published_at`** (première publication) plutôt qu'une colonne `published_updated_at` nouvelle : valeur toujours fiable (jamais touchée par les Saves), pas de colonne de plus.
- **Twitter réduit à `card` + `site`** : tout le reste retombe nativement sur l'OG — zéro duplication (mission §14).
- **`referrer` en `<meta>`** : les pages publiques sont statiques ; c'est la seule garantie portable, cohérente avec la politique des routes admin et l'analytics (domaines seulement).
- **Pas d'aperçu SERP/OG dans l'admin** : la mission le laissait « si peu coûteux » — une maquette honnête demande les assets typographiques du SERP ; reporté sans valeur perdue (les champs sont bornés et l'aperçu public existe).
- **E2E sur dev server — contournement documenté** : Astro dev mémoïse `getStaticPaths` par route après la première requête ; une page publiée **après** le réchauffement de `/articles/[slug]` renverrait 404 en dev (aucun slice antérieur n'avait visité une page publique fraîchement publiée — media.spec bénéficiait de la première visite). Le spec SEO touche le module de route et retente (`gotoPublicArticle`) : workaround **dev uniquement**, la production recalcule tout au build. Les specs existants ne changeaient pas de comportement.
- **JSON-LD = données, pas du code** : la garde « zéro script public » du build (slice 6/8) est ajustée pour tolérer `application/ld+json` à côté du beacon — aucun JS exécutable n'est ajouté (vérifié : aucune balise script hors beacon/ld+json dans le HTML buildé).

## Écarts assumés et risques reportés

- **En-têtes publics de production** (Referrer-Policy, XCTO, Permissions-Policy, HSTS, frame-ancestors) : à poser au niveau CDN/hosting lors de la mise en production réelle — le Core ne peut pas poser d'en-têtes sur du HTML statique ; documenté ci-dessus, pas de bricolage.
- **CSP du site public** : celle native d'Astro (déjà active dans le demo) ; `img-src` à compléter du domaine média en production. Pas de nonce/hashes additionnels — inutiles en static-first (mission §30).
- **Pas de sitemap index, pas de hreflang** (pas de notion de locale au-delà d'`og:locale` déclarative — cadrage : multilingue hors V1).
- **Override canonique cross-origin** : refusé (voir décisions) ; extension triviale si un cas réel apparaît.
- **Aperçu SERP admin** : reporté (voir décisions).

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc + astro check, 0 erreur) · `pnpm build` ✅ (core + démo, adapter Vercel — `robots.txt`/`sitemap.xml`/`404.html` vérifiés dans la sortie statique, fonctions serverless limitées à `/admin`+`/api`).
- `pnpm test` ✅ **588 verts** (unitaires ; intégration ignorée sans env) — dont **79 nouveaux tests SEO**.
- `pnpm test:integration` ✅ **125 verts** sur Neon réel — dont **5 nouveaux tests SEO** (Save ≠ Publish, OG ready/non-ready, comptage/suppression média, sitemap, drift) ; **zéro donnée résiduelle** vérifié sur les 9 tables `kreiz_*` après tous les runs.
- `pnpm test:e2e` ✅ **76 verts** (dont **8 nouveaux parcours SEO** : head complète, Save ≠ Publish, OG image via médiathèque, sitemap, brouillon absent, noindex, drift, robots/preview noindex).
- Auto-revue hostile (15 points de la mission §47) — voir ci-dessous.

## Auto-revue hostile (mission §47)

15 points passés en revue contre le code réel ; **3 constats corrigés** :

1. *Override canonique avec montée de chemin* — `'/../secret'` passait la validation de forme et produisait un canonical `https://site/../secret` → `..` rejeté à la validation **et** au rendu (test ajouté) ;
2. *Slashes consécutifs dans les chemins canoniques* — `/a//b///c` rendu tel quel (contenu dupliqué) → dédoublonnage déterministe en `/a/b/c` (test ajouté) ;
3. *`/admin/preview/<garbage>` en 500* — `findById` transmettait un id non-UUID au driver (22P02 brut) → garde UUID au repository, 404 propre (trouvé en déboguant l'E2E).

Points vérifiés sans constat : canonical spoofing (triple barrière Save/Publish/rendu, même origine, `javascript:`/`data:`/CRLF/hostiles écartés — tests) ; host poisoning (**aucune** lecture d'en-tête Host dans tout le module SEO — grep vérifié) ; XSS metadata (échappement intégral des attributs, tests hostiles) ; JSON-LD injection (`<` + U+2028/9 neutralisés, builders typés, tests) ; XML injection sitemap (`escapeXml`, chemins validés, grammaire des slugs) ; draft/public drift (snapshots + tests unit/integration/E2E) ; canonical périmé après changement de slug (dérivée du slug publié, tests) ; suppression média référencé OG refusée puis permise après retrait + republication (intégration réelle) ; fuite noindex (exclusion sitemap en SQL, meta robots, pas de canonical/og:url, preview forcée) ; URLs privées hors sitemap (requête publiés+indexables, `extraPaths` validés, `/admin`+`/api` en Disallow) ; duplication de meta (émetteur unique, HTML buildé vérifié) ; config malformée (schéma strict fail fast, revalidation idempotente) ; sécurité migration (**aucune migration**, chaîne 0000→0005 rejouée par les suites) ; headers/CSP (CSP native Astro vérifiée dans le HTML buildé — les blocs `application/ld+json` sont des données non exécutables, hors périmètre script-src ; beacon same-origin couvert par `script-src 'self'`) ; bundle public (zéro JS ajouté, garde build ajustée beacon+ld+json seulement, head 1,6 Ko).

## Risques de veille

- **En-têtes publics de production** (Referrer-Policy, XCTO, Permissions-Policy, HSTS, frame-ancestors) : à poser au niveau CDN/hosting lors de la mise en production réelle — le Core ne peut pas poser d'en-têtes sur du HTML statique ; `img-src` de la CSP démo à compléter du domaine média réel (préexistant au slice 5, env-dépendant).
- **Bornes SEO** (120/300) : pensées « raisonnables sans score » ; ajustables sans migration (validation applicative seule).
- **`og:locale` au format `fr-FR`** (tiret) : certainsconsommateurs attendent `fr_FR` (souligné) — Facebook accepte les deux ; ajustement trivial si un besoin réel apparaît.
- **E2E dev server** : le contournement `getStaticPaths` (touch + retry) est adossé au comportement du dev server Astro ; si une version future recalcule par requête, le helper devient un no-op inoffensif.
