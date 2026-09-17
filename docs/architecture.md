# Architecture de Kreiz Core

> Document de référence global (slice 10). Il décrit le Core **tel qu'il
> existe dans le code** — en cas de divergence, le code fait foi et ce
> document doit être corrigé.

## Vue d'ensemble

Kreiz est un **cœur éditorial réutilisable pour Astro** : il fournit le
back-office, le moteur de contenu, les médias, la publication, les
formulaires, l'analytics et le SEO. Chaque Project (application
consommatrice) fournit son branding, ses types de contenu, ses templates et
ses formulations — Kreiz ne fournit **jamais** de présentation imposée.

```
┌─────────────────────────────────────────────────────────────┐
│ Project (ex. apps/demo)                                     │
│  astro.config.ts ──► kreiz({ content, forms, seo, analytics })│
│  src/content-types/*  déclarations de types de contenu       │
│  src/forms/*          déclarations de formulaires            │
│  src/templates/*      templates publics (rendus aussi en     │
│                      preview admin)                          │
│  src/pages/*          pages publiques du Project             │
│  src/schema.ts        schéma composé (Core + Project)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ API publique @kreiz/core uniquement
┌──────────────────────────▼──────────────────────────────────┐
│ @kreiz/core (packages/core)                                 │
│                                                             │
│  domain/     règles pures, zéro dépendance I/O              │
│  services/   orchestration (auth, contenu, publication,     │
│              médias, contact, analytics)                    │
│  ports/      interfaces (Storage, ImageTransformer,          │
│              BackgroundJobs, Mailer, RebuildTrigger)         │
│  adapters/   implémentations de référence (S3 SigV4 maison, │
│              Sharp, waitUntil/fire-and-forget, webhook mail, │
│              deploy hook Vercel)                             │
│  data/       tables Drizzle, connexion Neon, repositories    │
│  http/       runtime serveur (env validée, guards, CSRF,     │
│              en-têtes de sécurité, mutations)                │
│  admin/      back-office SSR (pages Astro + routes POST)     │
│  content/    lecteur de build (snapshots publiés)            │
│  seo/ analytics/ forms/ rich-text/  helpers publics          │
│  cli/        `kreiz` (admin:create, admin:reset-password)    │
└─────────────────────────────────────────────────────────────┘
```

## Couches et règles de dépendance

| Couche | Rôle | Peut dépendre de |
|---|---|---|
| `domain/` | Règles métier **pures** : validation des documents, politiques (bornes, statuts), calculs de slugs, résolution SEO. Aucune I/O, aucun `process.env`. | rien |
| `services/` | Orchestration : authentification, CRUD contenu, publication, pipeline média, contact, analytics. Composent repositories + ports + domain. | domain, data (repositories), ports |
| `ports/` | Interfaces des dépendances externes : `ObjectStorage`, `ImageTransformer`, `BackgroundJobs`, `Mailer`, `RebuildTrigger`. | rien (types purs) |
| `adapters/` | Implémentations de référence des ports : S3-compatible avec SigV4 signé maison (aucun SDK), Sharp, `waitUntil` Vercel / fire-and-forget dev, relais webhook mail, deploy hook Vercel. | ports |
| `data/` | Tables Drizzle (`defineCoreTables`), connexion `createKreizDatabase` (driver HTTP Neon), repositories. **Le schéma appartient à l'app** : le Core ne possède aucune migration. | domain (types) |
| `http/` | Runtime serveur : validation centralisée de l'env (`server-env.ts`), composition du runtime, guards de session, CSRF lié à la session, en-têtes de sécurité, traitement des mutations POST. | services, data |
| `admin/` | Pages SSR du back-office (progressives, HTML d'abord) + routes POST + îlot d'édition riche Tiptap. | http, services |
| `content/`, `seo/`, `analytics/`, `forms/`, `rich-text/`, `media/` | Barils publics consommés par le Project au **build** et dans ses pages. | domain |

Invariants mécaniques :

- la carte `exports` du package est la frontière publique (garde :
  `tests/data-public-api.test.ts`) — aucun deep import possible ;
- aucun type Tiptap/ProseMirror ne fuit dans l'API publique (l'éditeur est
  confiné derrière l'adaptateur de `admin/richtext/`) ;
- les repositories sont des internals (slice 10) : le Project compose son
  schéma via `defineCoreTables` et migre, il n'accède pas aux données Kreiz
  en direct.

## Intégration Astro

`kreiz()` (unique export du sous-chemin racine) :

1. valide la configuration du Project (fail-fast, avant tout rendu) ;
2. lit `kreiz_redirects` au build (si `KREIZ_DATABASE_URL` est présent) et
   injecte les redirections 301 dans la config native Astro — matérialisées
   par l'adaptateur Vercel, jamais en SSR ;
3. expose la configuration (types, formulaires, SEO, analytics résolue) au
   code du Core via le module virtuel `virtual:kreiz/config` (templates
   importés statiquement — un chemin faux casse le build) ;
4. injecte les routes :

| Routes | Prerender | Session admin |
|---|---|---|
| `/admin/login`, `/admin`, `/admin/logout` | non | cookie `/admin` |
| `/admin/content/*` (CRUD, publish, unpublish, delete) | non | oui |
| `/admin/preview/[id]` | non | oui (noindex imposé) |
| `/admin/media/*` (bibliothèque, upload présigné, confirm, alt, retry, delete) | non | oui |
| `/admin/forms/*` (boîte de contact, statut, notification) | non | oui |
| `/admin/analytics` | non | oui |
| `/admin/rebuild` | non | oui |
| `/api/forms/[key]` | non | **jamais** (endpoint public) |
| `/api/analytics/event` | non | **jamais** (collecte publique) |
| `/api/analytics/beacon.js` | **oui** | jamais (fichier statique) |
| `/sitemap.xml`, `/robots.txt` | **oui** | jamais (fichiers statiques) |

L'invariant cookie : toutes les routes à session vivent sous `/admin/*`
(`Path=/admin`), les routes publiques n'y touchent jamais — garde mécanique
dans `tests/admin-routes.test.ts`.

## Save ≠ Publish ≠ Snapshot ≠ Build — le modèle de publication

C'est **le** point d'architecture à comprendre :

```
Draft (Save)          Publish (mutation admin)       Build public
─────────────         ───────────────────────        ──────────────
title, slug,          fige une copie dans les         lit UNIQUEMENT
data (JSONB),   ───►  colonnes published_*      ───►  les colonnes
seo, cover…           (published_title, slug,         published_* via
                      data, seo, cover,               createContentReader()
                      published_at, status)
```

- **Save** écrit l'état *éditorial courant* (`title`, `slug`, `data`,
  `seo`, `cover_media_id`). Il ne change **jamais** le site public.
- **Publish** valide l'état courant (médias référencés `ready`, SEO
  cohérent), le **fige** dans les colonnes `published_*` (snapshot
  atomique par contenu), écrit l'audit et demande un rebuild via le port
  `RebuildTrigger`. Un changement de slug publié crée une redirection 301
  (normalisation des chaînes, prévention de boucles).
- **Le build public** (Vercel deploy hook → `astro build`) ne lit que les
  snapshots `published_*` : les Saves non publiés ne peuvent pas fuiter
  dans le HTML servi. La couverture a son propre snapshot
  (`published_cover_media_id`).
- **Preview** (`/admin/preview/[id]`) rend l'état *courant* avec le même
  template que le public — jamais indexée.

Conséquences opérationnelles :

- l'échec d'un rebuild n'endommage rien : la base reste la source de
  vérité, le dernier site valide continue d'être servi, l'admin peut
  relancer ;
- la dépublication garde l'historique public (retour au draft, la page
  disparaît au prochain build) ;
- les redirections sont calculées *à l'écriture* puis matérialisées *au
  build* (cibles vivantes uniquement).

## Pipeline média

1. l'admin demande une **presign** (POST `/admin/media/upload-request`) —
   le serveur vérifie MIME/taille et signe un PUT direct (SigV4 maison) ;
2. le navigateur envoie le fichier **directement** au stockage S3-compatible
   (R2/MinIO/S3) — le fichier ne transite pas par le serveur ;
3. la **confirmation** (POST `/admin/media/[id]/confirm`) vérifie l'objet
   **réel** (taille, magic bytes) avant de passer `uploading → processing` ;
4. les variantes (400/800/1400/2000 px, WebP + AVIF, pas d'upscale, EXIF
   retiré) sont générées en arrière-plan (Sharp via `BackgroundJobs` :
   `waitUntil` sur Vercel, fire-and-forget en dev) → `ready` ;
5. originaux privés, variantes publiques immuables (`Cache-Control:
   immutable`).

États : `uploading → processing → ready | failed`. Recovery : retry des
`failed`, ré-enfilement des `processing` bloqués (jobs perdus) — voir
[operations.md](operations.md).

## Formulaires publics

- déclaration en code (`defineContactForm`), enveloppe email exclusive de
  la déclaration (pas d'open relay) ;
- rendu HTML progressif **sans JavaScript** ; jeton d'émission signé HMAC
  prouvant qu'une vraie page a été reçue ;
- anti-spam en couches : honeypot, temps minimal de remplissage (3 s),
  rate limiting PostgreSQL (5 / 10 min / IP hashée), validation stricte
  dérivée du schéma ;
- idempotence calculée côté serveur (index partiel unique sur `dedup_key`) ;
- persistance **avant** toute tentative de notification : une panne du
  transport n'importe jamais de perte ; retry avec backoff (2 min, 10 min,
  1 h, 6 h — 5 tentatives max), relance admin, balayage de rattrapage.

## Analytics privacy-first

- beacon **statique** prérendu (`/api/analytics/beacon.js`, ~2 Ko) référencé
  par les pages publiques du Project ;
- collecte : POST JSON borné sur `/api/analytics/event` — IP jamais stockée
  (hash HMAC éphémère pour le rate limiting), session éphémère
  sessionStorage, DNT/GPC respectés (aucune requête), bots filtrés ;
- événements : `page_view`, `cta_click`, `form_accepted`,
  `form_notification_sent` — **aucune donnée de formulaire** n'entre en
  analytics ;
- déduplication par tranche de 30 s ; rétention purgeable (défaut 90 j,
  bornes 7–365) ;
- dashboard admin en SQL pur (7/30/90 jours), aucun service tiers.

## SEO

- base canonique **toujours déclarée en code** (`defineSeoSiteConfig`) —
  jamais dérivée d'un en-tête `Host` ;
- résolution déterministe : Project → contenu publié → overrides éditoriaux
  (`resolveContentSeo`) ; head rendue par `seoHeadTags` (échappement
  contrôlé) ;
- JSON-LD typé (WebSite, Organization, BlogPosting, BreadcrumbList) ;
- `sitemap.xml` / `robots.txt` **prérendus** (fichiers statiques) ;
  `noindex` éditorial respecté (meta + exclusion du sitemap) ;
  `/admin` et `/api` exclus du crawl et marqués `X-Robots-Tag: noindex`.

## Ce que Kreiz n'est pas

Pas de page builder, pas de RBAC multi-rôles, pas de workflow éditorial
multi-étapes, pas d'i18n complet, pas de recherche full-text, pas de
scheduler interne (les recoveries attendent un cron externe), pas de
providers SaaS additionnels. Voir [technical-debt.md](technical-debt.md)
pour la frontière V1/V2 assumée.
