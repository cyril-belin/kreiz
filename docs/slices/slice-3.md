# Slice 3 — Moteur de contenu

Statut : **terminé — en attente de revue** · 2026-09-05

## Livré

- **Déclarations de types de contenu en code** : `defineContentType()` exposé
  par le nouveau sous-chemin public `@kreiz/core/content` — le Project déclare
  clé, libellés, namespace de route, champs (vocabulaire borné) et template ;
  rien n'est configurable depuis l'UI de l'admin.
- **Registre de types** alimenté par le canal validé du slice 0
  (`Project → kreiz(...) → virtual:kreiz/config → Core`) — le premier slice à
  le consommer réellement en production.
- **Vocabulaire de champs V1** : `text`, `textarea`, `select`, `url`, `date`,
  `metric` (paire label/valeur), `list` (items `text` ou `metric`).
- **Typage fort du JSONB `data`** : le schéma Zod strict est **dérivé** des
  descripteurs de champs par une fonction pure unique (`dataSchemaFromFields`)
  — Project et Core ne peuvent pas diverger ; `content_type = article` ⇒
  `data = ArticleData` par inférence, sans `Record<string, unknown>` côté
  Project.
- **CRUD admin générique** : listing par type, création, édition, suppression
  (soft) — formulaires HTML progressifs générés depuis les déclarations,
  sans JavaScript, sans Vue.
- **Slugs** : génération depuis le titre, normalisation Unicode, éditables
  ensuite, unicité par namespace, suffixage automatique `foo`, `foo-2`,
  `foo-3` pour les slugs générés, collision explicite = erreur de validation
  pour les slugs saisis à la main.
- **Route namespaces imposés serveur** : le namespace vient de la déclaration,
  jamais du client ; l'isolation des types est vérifiée à l'édition
  (un Article n'est pas éditable via une route Guide).
- **Preview SSR authentifiée** `/admin/preview/[id]` rendant **exactement le
  template public du Project** avec le même mapping de props que le futur
  rendu public.
- **Pages publiques de démonstration** prérendues (`/articles/[slug]`,
  `/guides/[slug]`, `/realisations/[slug]`) — 0 page tant qu'aucun contenu
  n'est publié (option A, mission §22) ; aucune mécanique Publish (slice 4).
- **Suppression de la route spike** `/api/kreiz/spike` — remplacée par des
  preuves réelles (voir ci-dessous).
- Navigation admin **générée depuis le registre** ; audit
  `content.created/updated/deleted` ; E2E, intégration Neon et build Vercel
  étendus.

## Dépendances ajoutées

**Aucune.** Zod (déjà présent) couvre la validation ; aucun nouveau paquet
n'apparaît dans `packages/core` ni `apps/demo`.

## Architecture du Content Engine

```text
Project (apps/demo)
   defineContentType() → astro.config.ts : kreiz({ content: { types: [...] } })
        ↓                                        (validation fail fast, Node pur)
   intégration @kreiz/core (astro:config:setup)
        ├─ plugin Vite « virtual-config »
        │     • config sérialisée (déclarations, sans composants)
        │     • imports STATIQUES des .astro du Project générés dans le module
        ↓
   virtual:kreiz/config   (export default + export const contentTemplates)
        ↓
   Core runtime (SSR admin/preview)
   getContentRegistry() → createContentTypeRegistry({ declarations, templates })
        ↓ revalidation complète (clés/namespaces uniques, composants présents)
   ContentService (createDraft / updateDraft / listContent / getContentForEdit /
                   deleteDraft) → ContentEntriesRepository → Neon
```

- `domain/content/` — règles pures sans I/O : descripteurs de champs et
  builders, dérivation du schéma Zod, déclaration (`defineContentType`),
  registre, slugs, vue mutualisée, erreurs de domaine.
- `services/content.ts` — orchestration : résolution du type, validation,
  imposition du namespace, slugs (dont course concurrentielle sur l'index
  unique), traçabilité `created_by`/`updated_by`, audit. Ne publie pas, ne
  connaît ni Vercel ni les templates.
- `http/content-form.ts` — parseur de formulaires : **whitelist stricte**
  (titre, slug optionnel, champs déclarés uniquement) ; `content_type`,
  namespace, statut, acteur et tout champ non déclaré POSTés sont ignorés.
- `http/admin-runtime.ts` — composition root des pages contenu (runtime admin
  + service contenu sur le registre) ; `server-env.ts` reste sans import du
  module virtuel (les tests unitaires ne le voient jamais).
- `data/repositories/content-entries.ts` — extensions slice 3 : `listByType`,
  `updateDraft`, `softDelete`, `slugExistsInNamespace`. Aucune méthode de
  publication ; Drizzle reste confiné à `data/repositories`.

### Chaîne de composition runtime

- `content/runtime.ts` (`getContentRegistry()`) importe le module virtuel et
  memoïse le registre ; il n'est importable **que** dans un contexte
  Vite/Astro. L'intégration, elle, ne l'importe pas : elle valide les
  contraintes de croisement (clés/namespaces uniques) en Node pur dès la
  config via `validateDeclarationCrossConstraints`, et vérifie l'existence de
  chaque fichier de template (`resolveTemplatePath`).

## API `defineContentType`

```ts
import { defineContentType, fields } from '@kreiz/core/content';

export const articleType = defineContentType({
  key: 'article',                 // identité en base (content_type)
  label: 'Article',
  labelPlural: 'Articles',        // navigation admin (défaut : label + « s »)
  routeNamespace: 'articles',     // → /articles/[slug], imposé serveur
  fields: {
    excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 300 }),
    body: fields.textarea({ label: 'Corps', required: true }),
    author: fields.text({ label: 'Auteur', required: true }),
  },
  template: 'src/templates/ArticleContent.astro', // relatif à la racine Astro
});

export type ArticleData = InferContentTypeData<typeof articleType>;
```

- Les builders posent le `kind` : les déclarations ne portent que du **sens**
  (label, aide, requis, bornes) — aucune classe CSS, aucune variante de layout
  (principe §1).
- `defineContentType` valide la forme à la définition (fail fast) et attache
  `dataSchema` (schéma dérivé) pour le typage du Project.
- La config revalide chaque déclaration (`kreizConfigSchema`) et **abandonne**
  `dataSchema` à la normalisation : seul le sens (descripteurs + chemin de
  template) voyage vers le module virtuel, le schéma est dérivé à nouveau côté
  runtime par la même fonction. La propriété est un slot explicite du schéma
  de config — ce n'est pas une clé inconnue tolérée.

## Registre

- `createContentTypeRegistry({ declarations, templates })` — **fonction pure**
  revalidant tout : forme des déclarations, unicité des clés, unicité des
  namespaces, présence et nature de composant du template (fonction).
- API : `list()` (ordre de déclaration = navigation), `findByKey` /
  `requireByKey` (lève `UnknownContentTypeError`), `findByNamespace` /
  `requireByNamespace`. Chaque déclaration résolue porte son schéma dérivé.
- Un registre vide est valide : un Project peut ne rien déclarer (l'admin
  affiche un état vide explicite).
- La navigation admin (« Contenu ») est **générée depuis `registry.list()`**
  dans `AdminShell.astro` — aucun type de demo n'est hardcodé dans le Core ;
  un autre Project déclarerait « Services », « Équipe »… sans modifier Kreiz.

## Vocabulaire de champs V1 et validation Zod

| Kind | Valeur stockée | Schéma dérivé |
|---|---|---|
| `text` | string | trim, min 1 si requis, max (défaut 200) |
| `textarea` | string | trim, min 1 si requis, max (défaut 20 000) |
| `select` | union des valeurs déclarées | `z.enum(...)` — liste fermée en code |
| `url` | string | `z.url({ protocol: /^https?$/ })` (URL absolue) |
| `date` | string | `z.iso.date()` (`YYYY-MM-DD`) |
| `metric` | `{ label, value }` | objet strict, deux chaînes 1–120 |
| `list` | tableau | items `text` ou `metric`, min 1 si requis, max (défaut 20) |

- Schéma racine : `z.strictObject` — **une clé inconnue dans le JSONB est une
  donnée corrompue**, jamais du contenu silencieusement accepté.
- Champs optionnels vides = clés **omises** du `data` (pas de chaînes vides en
  base) ; champs requis vides = erreur « Ce champ est requis. »
- Les messages affichés sont traduits en français par un mapping local des
  issues Zod (`contentFieldErrorMessage`) — pas de locale globale mutée à
  l'import.
- Données invalides en base → `ContentDataCorruptedError` : ni l'édition ni la
  preview ni le build public ne rendent silencieusement du contenu invalide
  (mission §4) ; au build le lecteur public fait **échouer le build**.

## Route namespaces et slugs

- `content_type` et `route_namespace` sont **toujours** cohérents avec la
  déclaration : le service impose le namespace de la déclaration (le client
  n'en soumet aucun), l'édition ne modifie jamais type ni namespace, et la
  page d'édition refuse un contenu dont le type ne correspond pas au segment
  d'URL (404 sans détail).
- Slug auto à la création depuis le titre (`slugify` : NFKD + retrait des
  diacritiques + ligatures courantes, minuscules, séparateurs compactés,
  max 120 caractères, repli `contenu` si aucun caractère sluggable) ;
  éditable ensuite — une édition ne régénère jamais le slug.
- Suffixage automatique `foo`, `foo-2`, `foo-3` **uniquement pour les slugs
  générés** (`slugCandidates`, borné à 50 essais, la course finale étant
  arbitraire par l'index unique PostgreSQL 23505 → candidat suivant) ; un
  slug saisi manuellement en collision est une **erreur de validation** — le
  choix explicite d'un admin n'est jamais modifié en silence.
- Unicité par namespace via l'index unique **partiel** existant
  (`(route_namespace, slug) WHERE deleted_at IS NULL`) : un slug soft-deleted
  redevient disponible (prouvé en E2E et en intégration).
- Pas de redirection au changement de slug : slice 4 (ce slice ne publie pas,
  un changement de slug de draft n'a aucun effet public).

## Routes admin (invariant `/admin/*` respecté)

```text
GET   /admin/content                       index des types (cartes + comptes)
GET   /admin/content/[type]                listing (titre, statut, slug, modifié, actions)
GET   /admin/content/[type]/new            création (POST sur la même URL)
GET   /admin/content/[type]/[id]           édition (POST sur la même URL)
POST  /admin/content/[type]/[id]/delete    soft delete (GET sans effet)
GET   /admin/preview/[id]                  preview SSR authentifiée
```

- Choix d'ergonomie : navigation par type (`/admin/content/article`…), pages
  mutations POST-sur-leur-propre-URL comme le login du slice 2 (formulaire
  progressif, erreurs re-rendues avec valeurs préservées, statut 400),
  redirect 303 vers l'édition après création et bandeau « Brouillon
  enregistré. » (`?saved=1`) après mise à jour.
- Toutes les mutations passent par le socle existant : guard de session
  (`resolveAdminAccess`), CSRF lié à la session (`verifySessionCsrfToken`),
  same-site/Fetch Metadata (`isTrustedSameSiteMutation`), `checkOrigin`
  natif Astro, en-têtes admin (`adminSecurityHeaders`). **Aucun deuxième
  système de guard/CSRF** ; le cookie reste `Path=/admin`.
- Le test garde `tests/admin-routes.test.ts` est étendu : chaque route
  injectée est une **constante d'`admin-routes.ts`** résolvant sous
  `/admin(\/|$)` — plus aucune exception (le spike a disparu) ; la carte
  `exports` inclut `./content` (garde `data-public-api.test.ts`).

## CRUD admin V1

- Listing : titre, badge de statut (Brouillon/Publié), slug (namespace/slug),
  date de modification, actions Éditer / Supprimer (POST + CSRF).
- Création : titre, slug optionnel (« Laisser vide pour générer depuis le
  titre »), champs du type générés depuis les descripteurs, Save draft.
- Édition : titre, slug, champs du type, Save draft, Preview, Supprimer.
- Hors périmètre (volontairement) : Publish/Unpublish, duplication, bulk,
  versions, publication planifiée, galerie, media picker (`cover_media_id`
  reste inutilisé dans l'UI), Tiptap (le `richText` arrive au slice 6 ; le
  descripteur `textarea` restera valable, aucun champ provisoire à retirer).

## Génération de formulaires admin

- `ContentFormFields.astro` rend chaque descripteur : input/textarea/select
  natif/input url/input date, métrique en paire d'inputs (`name:label` /
  `name:value`), listes en lignes fixes (ajout sans JavaScript). Ce n'est pas
  un form builder universel : le système est extensible (`media` au slice 5,
  `richText` au slice 6) sans casser les déclarations existantes.
- Les erreurs serveur sont re-rendues sous chaque champ (`role="alert"`),
  valeurs préservées ; le parseur ne lit jamais un champ non déclaré.

## Soft delete et audit

- Delete = `deleted_at = now()` + traçabilité, audit `content.deleted` ;
  absent des listings actifs, slug libéré par l'index partiel, aucune purge
  physique, pas de corbeille UI.
- Audit : `content.created`, `content.updated`, `content.deleted` avec le
  **vrai acteur admin** (session authentifiée — l'acteur vient du guard,
  jamais du formulaire), `entity_type = content_entry`, `metadata` minimale
  (`contentType`, `slug`) — pas de diff, pas de contenu stocké dans l'audit.

## Mécanisme de templates Project → Core (décision structurante du slice)

**Problème** : un composant `.astro` n'est ni sérialisable en JSON ni
transmissible via `injectRoute`/config statique ; le module virtuel du
slice 0 ne transportait que du JSON.

**Solution retenue** : le module virtuel `virtual:kreiz/config` est étendu à
**deux exports** :

```js
// généré par @kreiz/core:virtual-config
import * as template_0 from 'file:///…/apps/demo/src/templates/ArticleContent.astro';
const config = { … déclarations sérialisées … };
export default config;
export const contentTemplates = { article: template_0.default ?? template_0, … };
```

- **Imports statiques** générés (et non des imports dynamiques) : résolus à la
  construction — un chemin faux casse le build, jamais un rendu runtime ;
  l'existence du fichier est de plus vérifiée dès `astro:config:setup`
  (`resolveTemplatePath`, relatif à la racine Astro ou absolu, spécificateur
  `file://` pour la robustesse Windows).
- Le Core n'importe **jamais** un template par chemin interne au Project : il
  joint les composants aux déclarations dans le registre.
- Rejeté : registre global rempli à l'exécution d'astro.config (effets de
  bord) ; `import.meta.glob` sur une convention de dossier (caché, fragile) ;
  fonctions passées dans la config (non sérialisables).
- Compromis documenté : le type du composant runtime reste opaque côté Core
  (`KreizTemplateComponent`, cast confiné à la page de preview) — le typage
  fort du template vit côté Project (voir ci-dessous).

## Typage des templates (mission §28)

- Le Project type lui-même ses templates avec la vue mutualisée :

```ts
import type { ContentView } from '@kreiz/core/content';
import type { ArticleData } from '../content-types/article.js';

interface Props { view: ContentView<ArticleData> }
```

- `ContentView<TData>` expose `id/contentType/routeNamespace/title/slug/
  status/publishedAt/updatedAt/seo/data: TData` — aucun `data: unknown` dans
  le code Project ; l'inférence vient des descripteurs
  (`InferContentTypeData`), les unions de `select` incluses.
- Le chemin template (string) ne peut pas être vérifié par TS contre `TData` :
  la cohérence est par convention + la validation runtime du schéma (données
  invalides = erreur, pas un rendu silencieux). Compromis assumé et documenté.

## Preview et rendu public partagé (mission §23)

- **Mapping unique** : `resolveContentViewModel(declaration, entry)` vérifie
  type, namespace et `data` (schéma strict) et produit la même vue pour
  - la **preview SSR** (`/admin/preview/[id]`, Core) — template issu du
    registre ;
  - le **rendu public** (pages du Project) — template importé directement par
    le Project, données issues du lecteur de build.
- Preuve d'unicité du template : le composant de preview provient du **même
  fichier** (import généré dans le module virtuel ⇔ import direct des pages
  publiques) ; l'E2E asserte les marquages propres au template réel.
- `createContentReader({ databaseUrl })` (`@kreiz/core/content`) — lecteur de
  build des pages publiques : `listPublishedViews({ declaration })` et
  `getPublishedViewBySlug`, publiés uniquement, tri par `published_at` desc,
  corruption = échec de build. Zéro requête Neon pour *servir* une page
  (prérendu), requêtes build-time uniquement.

## Pages publiques de démonstration (option A)

- `/articles/[slug]`, `/guides/[slug]`, `/realisations/[slug]` :
  `getStaticPaths` retourne `[]` sans `KREIZ_DATABASE_URL` au build (PR de
  fork) et **0 page tant qu'aucun contenu n'est `published`** — le build
  vérifié émet exactement `static/index.html` + fonction SSR admin.
- Aucun faux comportement de publication : les templates affichent
  « brouillon (preview) » quand `publishedAt` est null.
- `apps/demo/src/templates/` : trois templates publics réels (Article, Guide
  avec badge de difficulté, Case Study avec grille de métriques), Tailwind du
  projet, important `global.css` (le CSS voyage avec le composant — la
  preview SSR l'obtient donc gratuitement).

## Suppression de la route spike (mission §38)

- `src/routes/spike.ts` supprimé ; la section `spike` de la config n'existe
  plus (`kreizConfigSchema` est `strictObject` : la clé est désormais rejetée).
- Les invariants que le spike portait seul sont prouvés par le slice :
  - configuration Project → Core consommée en production par des vraies
    routes (registre des types, navigation admin, preview) ;
  - module virtuel étendu (JSON + imports de composants) ;
  - `injectRoute` étendu à 6 nouvelles routes SSR sous `/admin` ;
  - build Vercel avec résolution des templates dans le bundle SSR.
- Le test garde `admin-routes.test.ts` interdit explicitement le retour d'une
  route injectée hors `/admin` (constantes uniquement + pattern spike
  interdit + dossier `src/routes` inexistant).

## Sécurité (mission §29 — conservée, étendue)

Sessions, guards, cookie `Path=/admin`, CSRF session-bound, same-site/Fetch
Metadata, rate limiting login, CSP native Astro, en-têtes admin, noindex
(`X-Robots-Tag` + `<meta>` sur la preview également). Nouvelles surfaces :
toutes les mutations contenu sont derrière le même guard + CSRF + same-site ;
le parseur whiteliste strictement ; les erreurs ne révèlent ni SQL, ni stack,
ni payload interne, ni config du Project ; les 404 d'isolation de type ne
distinguent pas « contenu absent » et « mauvais type ».

## Tests

- **Unitaires** (`packages/core/tests/`) — 73 nouveaux tests :
  - `content-type.test.ts` : déclarations valides/invalide (clé, namespace,
    template, kind inconnu, select vide) ; schéma dérivé (clé inconnue,
    requis, select fermé, URL http(s), date ISO, métrique incomplète,
    optionnels absents) ;
  - `content-registry.test.ts` : résolution composants + schéma, ordre de
    `list()` (base de la nav), pluriel par défaut, clé/namespace dupliqués,
    forme invalide, template absent/non-composant, registre vide,
    `validateDeclarationCrossConstraints` ;
  - `content-slug.test.ts` : slugify (accents, ligatures, séparateurs,
    troncature), normalisation saisie manuelle, candidats `foo/foo-2/foo-3`,
    `resolveGeneratedSlug`, repli non vide ;
  - `content-form.test.ts` : whitelist stricte (content_type/status/
    created_by/inconnus ignorés), chaque kind, métriques incomplètes, listes,
    re-rendu fidèle, formulaire vide ;
  - `content-service.test.ts` (doubles en mémoire `helpers/in-memory-content.ts`)
    : namespace imposé, slug auto/suffixage, collision manuelle, validation
    titre/data avant écriture, titre trop long, type inconnu, isolation des
    types, audit created/updated/deleted avec vrai acteur, update (slug
    conservé/modifié/collision, updated_by), listing par type hors supprimés,
    `getContentForEdit/Preview` (corrompu → erreur, supprimé → erreur),
    soft delete + slug réutilisable ;
  - `content-view-model.test.ts` : mapping unique, refus de type croisé,
    namespace incohérent, data invalides.
- **Mise à jour des gardes** : `config.test.ts` (section content, spike
  rejeté), `admin-routes.test.ts` (constantes + préfixe, spike interdit),
  `data-public-api.test.ts` (`./content`).
- **Intégration Neon** (`tests/integration/content-entries.test.ts`, 9 tests,
  0 donnée résiduelle vérifiée) : create draft (persistance titre/data,
  namespace imposé, traçabilité), suffixage réel sur collisions, validation
  invalide sans persistance, update + audit lu en SQL (created puis updated,
  acteurs distincts), **23505 réel de l'index unique partiel**, isolation des
  listings par type, données corrompues en SQL direct →
  `ContentDataCorruptedError`, soft delete + réutilisation du slug + audit
  deleted, preview resolver sur brouillon.
- **Intégration Neon — chemin public build-time**
  (`tests/integration/public-build.test.ts`, 2 tests — voir la section
  « Preuve du chemin public build-time » ci-dessous).
- **Garde demo — template partagé** (`apps/demo/tests/public-template.test.ts`,
  3 tests) : pour chacun des trois types, le chemin `template` déclaré par
  `defineContentType` résout **exactement** le fichier importé par sa page
  publique, et la page est bien `prerender = true` — un seul module de
  template par type, aucune copie parallèle.

## E2E Playwright (`apps/demo/e2e/content.spec.ts`, 8 parcours)

Navigation depuis la nav générée (Articles/Guides/Réalisations visibles) ·
création (formulaire généré → retour édition → **slug auto vérifié en base** :
statut draft, namespace imposé) · validation (requis absent → erreur visible,
valeurs préservées, **0 ligne en base**) · slugs (manuel sauvegardé, collision
manuelle → erreur, auto en collision → suffixage, collision à l'édition →
erreur) · édition (modification → 303 + bandeau → valeur retrouvée en base) ·
preview (vrai template : mention « brouillon (preview) », données rendues,
signature du footer ; noindex ; **sans session → 302 vers login**) ·
suppression (soft delete vérifié en base, absent du listing, audit
`content.deleted`, **slug réutilisable**) · isolation des types (route Guide
sur un Article → 404, panel sans détail).

Les comptes sont créés par le CLI (global-setup inchangé) ; le teardown
étendu supprime audit → contenus → admins (ordre FK) : **0 ligne résiduelle
vérifiée** après run complet.

**Découverte de run** : `fullyParallel: false` ne sérialise que *dans* un
fichier — avec deux specs, `admin.spec.ts` (révocation/expiration des
sessions de l'admin partagé) et `content.spec.ts` tournaient en workers
parallèles et s'invalidaient mutuellement (session révoquée en plein
parcours, 302 vers login diagnostiqué via la trace Playwright : cookie
constant, `resolveSession` refusé). Correctif : **`workers: 1`** (les specs
partagent une base réelle et un admin commun) — 17/17 verts.

## Build Vercel (sortie `.vercel/output/` vérifiée)

- Public prérendu : `static/index.html` uniquement — **0 page dynamique**
  tant qu'aucun contenu n'est publié ; les routes `/articles|/guides|
  /realisations/[slug]` existent dans le graphe mais n'émettent rien.
- Fonction SSR unique contenant les 9 patterns `/admin/*` (login, shell,
  logout, contenu ×5, preview).
- Déclarations de types et **templates du Project présents dans le bundle SSR**
  (chunks `admin-runtime`, textes des templates retrouvés) — le module virtuel
  reste sérialisable (données JSON + imports résolus au bundle).
- Binaire Argon2 `.node` tracé dans la fonction (comme au slice 2).
- Aucune DB appelée pour servir les pages statiques déjà générées (les
  requêtes Neon des pages publiques n'ont lieu qu'au build, et seulement si
  `KREIZ_DATABASE_URL` est présent).

## Responsive admin (mission §36)

Vérifié en Chromium réel sur les 6 écrans (dashboard, index contenu, listing,
création, édition, preview) à **1440 / 1024 / 768 / 390** : **0 px d'overflow
horizontal partout**. Le listing devient des cartes empilées (`<table>` en
blocs avec libellés répétés) ≤ 768 px, les actions et boutons passent en
pleine largeur, les paires métrique se verticalisent.

## CI

Le workflow existant couvre déjà les nouveaux tests sans modification de
structure : `quality` (lint · build · typecheck · unit — dont les 73 tests du
moteur) ; `integration` (branche Neon éphémère : migrer → tests d'intégration
→ E2E → cleanup `if: always()`, forks sans secrets → notice + succès).
Seul commentaire de job mis à jour.

## Décisions et difficultés d'implémentation

1. **Descripteurs = source de vérité unique** : le Project ne fournit jamais
   de schéma Zod ; `defineContentType` le dérive, le module virtuel ne
   transporte que des données, le registre runtime le dérive à nouveau par la
   même fonction pure. Validation Project/Core incapable de diverger, et
   config réellement sérialisable.
2. **Templates par imports statiques générés dans le module virtuel** (voir
   ci-dessus) — la décision architecturale principale du slice : échouer au
   build plutôt qu'au runtime, sans dépendance inversée ni chemin interne au
   Project importé par le Core.
3. **Un sous-chemin public `./content`** (`@kreiz/core/content`) : les
   déclarations, règles pures (slug, vue), lecteur de build. La couche data
   reste la seule porte Drizzle ; pas d'autres subpaths.
4. **Suffixage vs erreur** : auto → suffixe ; manuel → erreur. Un choix
   explicite d'admin ne se modifie pas en silence (l'E2E couvre les deux).
5. **Le `rich text` n'a pas d'abstraction provisoire** : `textarea` simple,
   rendu texte (Astro échappe les expressions — pas besoin de sanitizer ce
   slice) ; le descripteur restera valable au slice 6.
6. **`APIContext` n'expose pas `response`** (réservé au global `Astro` dans
   Astro 7) : le socle commun des pages admin est typé structurellement
   (`ContentPageContext`) — `Astro` le satisfait.
7. **astro check ne couvre pas les pages `.astro` injectées depuis `dist/`** :
   une import manquant (`adminContentNewPath` dans la page de création) a
   passé typecheck et build, mais a été attrapé par l'E2E (erreur runtime) et
   corrigé. La couverture E2E des pages injectées est donc indispensable ;
   aucune autre occurrence trouvée (toutes les pages sont parcourues).
8. **Regex à accolades dans les templates** (`/\n{2,}/`) : le compilateur
   .astro perd l'équilibrage des accolades sur les regex littérales avec
   quantificateurs (`ts(2304)` en astro check) — remplacé par `/\n\s*\n/`.
9. **Textarea et blancs de gabarit** : Astro préserve l'indentation dans un
   `<textarea>` multi-lignes (valeur polluée) — expression rendue sur une
   seule ligne.
10. **E2E multi-fichiers sur une base partagée** : voir découverte ci-dessus
    (`workers: 1`), documentée pour les slices futurs — tout nouveau spec
    partage le worker et l'admin communs.
11. **Rate limiter de login vs tests** : les succès réinitialisent les
    compteurs (email + IP) — les nombreux logins E2E ne saturent jamais le
    budget « 5 échecs / 15 min » ; les échecs intentionnels du spec slice 2
    restent sous la limite.

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc core + astro check, 0 erreur) ·
  `pnpm test` ✅ (**170 tests unitaires**) · `pnpm build` ✅ (core tsc + copy,
  demo astro build + adapter Vercel) · `pnpm test:integration` ✅
  (**58/58** sur la branche Neon de développement, dont 9 nouveaux du moteur
  et 2 de la preuve build-time public) · E2E ✅ (**17/17**, Chromium contre
  serveur dev SSR + Neon).
- **Build Vercel** : sortie vérifiée (voir section dédiée) ; **preuve
  build-time public** : page statique réelle générée puis exclusions et
  échec sur data invalide vérifiés (section ci-dessus).
- **Données résiduelles : 0** (content_entries, audit, users, sessions,
  rate_limits comptés à 0 après intégration + E2E + vérifications
  manuelles). Aucune migration générée : le moteur repose sur
  `kreiz_content_entries` (slice 1) — `packages/core` ne possède toujours
  aucun dossier de migration (garde testée).

## Preuve du chemin public build-time (revue du slice — ajoutée avant commit)

La preview SSR était prouvée, mais tant qu'aucune entrée `published` n'existe
au build, Astro émet 0 page dynamique : la chaîne publique complète n'avait
jamais été exécutée bout en bout. Elle l'est maintenant par un test
d'intégration dédié (`packages/core/tests/integration/public-build.test.ts`),
**sans aucune logique Publish** (slice 4) : les fixtures sont créées
directement en base par le repository (infrastructure de test uniquement).

**Mécanisme** : création de trois fixtures Article conformes aux déclarations
du demo (`content_type = article`, namespace `articles`) — une **publiée
valide**, un **brouillon**, un **publié puis soft-deleted** — puis lancement
du **vrai build Astro** de `apps/demo` (spawn `astro build`, adapter Vercel,
`KREIZ_DATABASE_URL` fourni) et inspection de `.vercel/output/`.

**Résultats assertés** :

1. `static/articles/<slug>/index.html` existe et contient : le **titre**
   (colonne commune), l'**excerpt** et la ligne « Par {author} » (**data
   typé**), la signature du **vrai template** `ArticleContent.astro`
   (« Kreiz, application de démonstration » — les mêmes marqueurs que
   l'E2E preview) et **pas** le marqueur « brouillon (preview) »
   (contenu publié).
2. **Exclusions** : aucun dossier ni `index.html` pour le brouillon ni pour
   le soft-deleted dans la sortie statique.
3. **Partie statique, pas SSR** : aucune route `articles` dans la table de
   routage `config.json` de Vercel, et le slug n'apparaît dans **aucun**
   module du bundle `functions/` (le contenu prérendu ne rentre jamais dans
   la fonction).
4. **`data` invalide** : une quatrième fixture publiée sans le champ requis
   (`excerpt`) fait **échouer explicitement le build** — le message de
   `ContentDataCorruptedError` (« données du contenu … invalides ») et la
   frame `resolveContentViewModel` apparaissent dans la sortie, et aucune
   page n'est produite pour ce slug. Contrat du lecteur : on ne prérend
   jamais silencieusement du contenu invalide.
5. **0 donnée résiduelle** : les fixtures sont supprimées en `afterAll`
   (par slug préfixé + auteur de test, jamais par namespace — le namespace
   `articles` peut contenir du contenu réel) ; les dossiers
   `static/articles|guides|realisations` sont retirés pour rendre à la
   sortie de build son état « 0 page dynamique ».

**Preuve template partagé preview ⇄ public** — trois points qui se
complètent, sans nouvelle abstraction :

- structurelle : le registre joint les composants aux déclarations
  (`contentTemplates[key]`, testé en unitaire Core) et le garde demo
  (`public-template.test.ts`) prouve que le chemin déclaré est exactement le
  fichier importé par la page publique ;
- dynamique côté preview : l'E2E asserte les marqueurs du template réel
  (`ArticleContent.astro`) dans le HTML de `/admin/preview/[id]` ;
- dynamique côté public : le test de build ci-dessus asserte les mêmes
  marqueurs dans le HTML statique de `/articles/<slug>`.

Donc preview et public rendent le **même module** avec le **même mapping**
(`resolveContentViewModel`) — aucune copie parallèle du renderer.

## État Git

Travail **non commité** (revue demandée avant validation) — base
`main = eadd3db`, aucun historique réécrit, aucun push.
