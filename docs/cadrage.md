# Kreiz — Astro Editorial Core

**Document de cadrage** · Version 1.1 · 2026-09-05 · Statut : **Validé** — ajustements 1 à 4 intégrés

Ce document fige la vision, le périmètre, l'architecture et les décisions de la V1 de Kreiz.
Aucune implémentation ne commence avant validation explicite de ce cadrage.

---

## 1. Vision

Kreiz est une fondation réutilisable pour créer rapidement des sites professionnels
administrables, éditoriaux et semi-statiques avec Astro, chacun doté d'un back-office privé.

Le principe fondamental :

> **Le back-office gère le contenu. Le frontend décide de la mise en page.**

Kreiz n'est ni WordPress, ni un page builder, ni un SaaS multi-tenant, ni un CMS universel.
C'est un moteur éditorial générique, sans métier ni marque, destiné à être consommé par des
projets indépendants (nos propres sites, les sites clients de lesreseaux.fr, et à terme des
tiers s'il devient open source). Kreiz est conçu dès le départ pour pouvoir être publié comme
package versionné, sans que l'infrastructure de publication soit construite en V1.

## 2. Principes fondateurs

1. **Contenu ≠ présentation.** Le CMS stocke du sens structuré (textes, images, métriques,
   catégories, SEO, statuts). Jamais de padding, de largeur, de couleur libre, de grille ou de
   classe Tailwind.
2. **Le navigateur ne touche jamais Neon.** Toute lecture et écriture passe par la couche
   serveur appropriée. Une page éditoriale classique se sert sans aucune requête base de
   données : elle est du HTML statique.
3. **Core sans métier.** Le Core est générique et réutilisable ; le branding, les types de
   contenu concrets, les templates, le wording et les champs métiers appartiennent au projet.
4. **Types de contenu déclarés en code.** Rien n'est créable ni configurable depuis l'UI de
   l'admin. L'admin génère ses formulaires à partir des déclarations, il ne les édite pas.
5. **Plateformes derrière des ports.** Vercel, R2/S3, Resend, Neon sont des adapters. Aucune
   API plateforme n'apparaît dans le domaine (média, contenu, publication).
6. **Simplicité d'abord.** Toute abstraction répond à un besoin réel démontré. Pas de port,
   pas de colonne, pas de module spéculatif — mais rien de ce qui est construit ne doit fermer
   une évolution prévisible.
7. **Sécurité et sobriété des données par défaut.** Validation serveur systématique, mutations
   protégées, pas d'IP complète persistée, pas d'User-Agent brut stocké, append-only pour
   l'audit.
8. **Performance.** HTML prérendu servi par CDN, très peu de JavaScript public, Core Web
   Vitals comme contrainte de conception.
9. **`apps/demo` est un consommateur externe du Core à l'intérieur du monorepo.** Aucun import
   profond dans `packages/core/src`. Si le demo se construit proprement avec cette seule
   contrainte, la frontière Core/Project est prouvée.

## 3. Périmètre V1

- Architecture Astro propre (monorepo pnpm, TypeScript strict, Tailwind, Vue islands ciblées).
- Connexion Neon + définitions de schéma Drizzle du Core ; migrations appartenant aux apps.
- Authentification admin (email + mot de passe argon2id, sessions révocables en base, guards).
- CLI `kreiz` : création du premier admin, reset mot de passe.
- CSRF, rate limiting, en-têtes de sécurité, journal d'audit append-only.
- Back-office privé : shell, layout, listing/édition génériques, media picker, boîte de contact,
  dashboard analytics, page d'aperçu.
- Moteur de contenu générique : `content_entries` + déclarations de types en code,
  brouillon/publication, slugs avec namespaces de route, redirections automatiques normalisées.
- Rich text : éditeur Tiptap (island Vue), HTML sanitisé serveur comme format canonique.
- Médias : upload direct présigné vers stockage objet S3-compatible, cycle de vie explicite,
  variantes d'images générées de façon asynchrone derrière un port.
- Formulaire de contact public déclaré en code, anti-spam multi-couches, port `Mailer` optionnel.
- Analytics internes : 3 événements, session anonyme éphémère, rétention configurable,
  dashboard minimal.
- SEO : meta par contenu, sitemap, robots, JSON-LD, images sociales sélectionnables.
- Pages 404/500 (défauts du Core, personnalisables par projet).
- Tests (unitaires, intégration sur branche Neon, E2E Playwright) et CI à niveaux.
- `apps/demo` : application de référence démontrant l'intégralité des APIs publiques.
- Documentation d'architecture et de handoff.

## 4. Hors périmètre V1

Annuaire d'entreprises, avis, notation, classements locaux, catégories territoriales ;
gestion commerciale, abonnement, facturation ; provisioning de sites clients ; multi-tenant ;
page builder ; marketplace, plugins ; permissions multi-rôles ; workflow éditorial avancé ;
multilingue ; moteur de thèmes dynamique ; form builder ; publication planifiée ; versioning /
historique de contenu ; 2FA active ; partage d'aperçu par token externe ; RSS ; génération
automatique d'images OG ; scaffolder CLI ; Redis ; événements analytics avancés (scroll depth,
form_started, heatmaps, attribution) ; SSR ou rendu hybride du public ; publication npm.

Chacun de ces points est repoussé pour motif (voir §22), pas par oubli.

## 5. Architecture générale

```text
VISITEUR                          ADMIN
   │                                │
   ▼                                ▼
CDN (HTML statique du build)    /admin (SSR Astro, session serveur)
   │  endpoints dynamiques :        │
   │  POST formulaires              │
   │  POST analytics                │ guards → CSRF → services
   ▼                                ▼
         Couche serveur Astro (fonctions) + repositories (Drizzle)
                          │                       │
                          ▼                       ▼
                    Neon PostgreSQL         Ports → adapters
                                          (R2/S3, Rebuild,
                                           Jobs, Mailer)
```

Flux de publication :

```text
Admin : Save (aucun effet public)
     → Publish / Unpublish / changement de slug publié
     → audit + mécanique de publication (redirects, états)
     → RebuildTrigger (port) → deploy hook (adapter Vercel)
     → build Astro : relecture de Neon via repositories
     → HTML statique redéployé (déploiement atomique :
       un build échoué laisse l'ancien site servi)
```

Le Core fournit une **intégration Astro** (injection de routes) qui monte `/admin`, les
endpoints d'API et la page de preview dans l'app consommatrice. Le projet n'écrit aucune
plomberie d'admin : il déclare ses types de contenu, ses formulaires et ses templates.

## 6. Responsabilités des couches

| Couche (`packages/core/src`) | Responsabilité | Interdits |
|---|---|---|
| `domain` | Types, règles pures : slugs, namespaces, redirections, états éditoriaux et médias, schémas de validation, helpers SEO | Aucune I/O, aucun import Drizzle/Astro |
| `data` | `defineCoreTables()` (définitions Drizzle) + **repositories** par domaine — seule couche qui parle à Neon/Drizzle | Logique métier au-delà du mapping |
| `services` | Orchestration : publication, médias, formulaires, analytics, audit, rate limiting | Connaître une plateforme |
| `http` | Helpers de routes, guards de session, CSRF, endpoints réutilisables, intégration Astro (`injectRoute`) | Requêtes DB hors repositories |
| `admin` | Shell d'admin, composants génériques, islands Vue (Tiptap, media picker, contrôles) | Style de site public |
| `ports` | Contrats : `ObjectStorage`, `ImageTransformer`, `BackgroundJobs`, `RebuildTrigger`, `Mailer` | Implémentation |
| `adapters` | Vercel (rebuild, jobs via `waitUntil`), S3/R2, Resend (exemple), sharp | Être importés par `domain`/`services` directement |
| `cli` | Bin `kreiz` : `admin:create`, `admin:reset-password` | — |

Les dépendances pointent toujours vers le domaine. L'application compose : sa configuration,
son schéma (core + projet), ses types de contenu, ses templates, ses adapters, ses env.

## 7. Modèle de données

Le Core exporte des **définitions de tables** ; il ne possède aucune migration.
L'application compose `core schema + project schema` et drizzle-kit génère sa propre chaîne.
Une mise à jour de Kreiz peut donc entraîner une migration dans l'app consommatrice (documentée).

Tables du Core — préfixe `kreiz_` **figé en V1** (le nom des tables appartient au schéma et
aux migrations de l'application ; le rendre configurable suggérerait une option runtime alors
qu'un changement exige une vraie migration) :

- **`kreiz_admin_users`** — `id`, `email` (unique), `password_hash` (argon2id), `name`,
  `disabled_at` nullable, `created_at`, `updated_at`. Pas de colonne TOTP ni de flag
  spéculatif. **Désactivation ≠ suppression** : `disabled_at = now()` révoque toutes les
  sessions de ce compte et interdit toute nouvelle connexion ; la ligne reste en base pour
  préserver l'intégrité de `actor_admin_id`, de `created_by` / `updated_by` et des
  investigations d'incident futures. Pas de suppression d'administrateur depuis l'interface
  en V1.
- **`kreiz_admin_sessions`** — `id`, `admin_id` FK, `token_hash` (le token brut n'est jamais stocké),
  `created_at`, `last_seen_at`, `expires_at` (glissant 14 j), `absolute_expires_at`
  (limite absolue, défaut 90 j), `revoked_at`. Révocation unitaire (« déconnecter partout »).
- **`kreiz_admin_audit_log`** — `id`, `actor_admin_id`, `action` (`content.created`, `content.updated`,
  `content.published`, `content.unpublished`, `content.deleted`, `media.deleted`,
  `contact.status_changed`, `admin.login`, `admin.logout`, …), `entity_type`, `entity_id`,
  `metadata` jsonb minimal, `created_at`. **Append-only** : aucun code applicatif n'update ni ne
  supprime ; aucun bouton d'admin n'expose d'édition. Pas d'IP complète.
- **`kreiz_content_entries`** — `id`, `content_type` (clé de déclaration), `route_namespace`,
  `title`, `slug`, `cover_media_id` FK nullable, `status` (`draft | published`),
  `published_at`, `seo` jsonb (`title`, `description`, `canonical_override`,
  `og_image_media_id`), `data` jsonb (validé par le schéma du type déclaré),
  `created_by` / `updated_by` FK, `created_at`, `updated_at`, `deleted_at` (soft delete).
  Index : `UNIQUE(route_namespace, slug)` partiel (`WHERE deleted_at IS NULL`) ;
  `(content_type, status, published_at DESC)` ; `(route_namespace, published_at DESC)`.
- **`kreiz_redirects`** — `id`, `from_path` (unique, normalisé), `to_path`, `content_entry_id`
  nullable, `created_at`. Écriture toujours normalisée (cible terminale résolue, boucles
  interdites, ancien slug réapparu = conflit détecté). Lecture = lookup simple.
- **`kreiz_media`** — `id`, `status` (`uploading | processing | ready | failed`), `failure_reason`
  nullable, `storage_key` (original), `mime`, `size_bytes`, `width`, `height`, `alt_text`,
  `variants` jsonb (`[{ key, width, format, size_bytes }]`), `uploaded_by` FK, `created_at`,
  `updated_at`, `deleted_at`. Les templates ne référencent que des médias `ready`. L'original
  est conservé selon la politique du projet et n'est jamais considéré comme variante publique
  optimisée.
- **`kreiz_contact_requests`** — `id`, `form_id` (clé du formulaire déclaré), `payload` jsonb (validé
  par le schéma du formulaire), `status` (`new | handled`), `created_at`. Pas d'IP complète,
  pas d'UA brut.
- **`kreiz_analytics_events`** — `id`, `event_name` (`page_view | cta_click |
  contact_form_submitted`), `path`, `referrer`, `session_id` (anonyme, éphémère),
  `content_type` / `content_entry_id` nullables, `device_class` nullable
  (`mobile | tablet | desktop`), `country` nullable (enrichissement plateforme **optionnel**,
  jamais requis par le modèle), `metadata` jsonb minimal, `created_at`. Index sur
  `(event_name, created_at)` et `created_at`. Rétention configurable (défaut 12 mois) + purge.
- **`kreiz_rate_limits`** — `key`, `window_started_at`, `count`. Incréments atomiques (upsert
  concurrent-safe), purge opportuniste.

Les types projet ajoutent leurs propres tables (satellites avec FK `kreiz_content_entries.id`) quand
les règles de promotion l'exigent : relation SQL réelle, contrainte forte, requête/fréquence,
filtrage/tri important, agrégation, volumétrie.

## 8. Mécanisme de types de contenu

Un type de contenu est **déclaré en code** par le projet :

- `key` (ex. `article`), `label`, `routeNamespace` (ex. `articles` → `/articles/[slug]`) ;
- `dataSchema` : schéma strict (Zod) du JSONB, avec un **vocabulaire de champs borné** :
  texte court, texte long, rich text (HTML sanitisé), image (référence média, alt requis),
  select, liste, métrique, URL, date ;
- options de listing admin et mapping vers le template du projet.

Le Core fournit : CRUD générique, formulaires d'édition générés depuis la déclaration,
validation serveur, slugs, publication, preview, exclusion des drafts/deleted du build.
Un projet définit `article`, `guide`, `case_study`, `service`… sans jamais modifier Kreiz.
`apps/demo` fournit Article, Guide et Case Study comme définitions de référence — ils
**n'appartiennent pas au Core**.

## 9. Stratégie de rendu Astro

- Output statique : tout le public est prérendu au build ; l'adapter Vercel ne sert des
  fonctions que pour `/admin`, la preview et les endpoints contrôlés (formulaires, analytics,
  signature d'upload).
- Les pages publiques consomment les données via les repositories au build. Zéro requête Neon
  pour servir une page éditoriale ; résilience : si Neon est momentanément indisponible, le
  site public continue d'être servi.
- **Preview** : `/admin/preview/[id]` — SSR, authentifiée, `X-Robots-Tag: noindex`, rendant le
  brouillon avec **exactement les mêmes templates** que le public. Aucun renderer parallèle.
- Rebuild déclenché par les actions de publication via `RebuildTrigger`. Les déploiements
  Vercel étant atomiques, un build échoué ne dégrade jamais le site servi.
- Drafts, supprimés (soft), et tout `/admin` exclus du build public (pages, sitemap, JSON-LD).

## 10. Stratégie d'authentification

- Email + mot de passe, hachage **argon2id**. Aucun credential dans les variables d'env.
- **Bootstrap** : `pnpm kreiz admin:create` (bin du package, exécuté avec l'accès Neon) crée
  le premier admin ; `pnpm kreiz admin:reset-password` pour la réinitialisation en V1.
- **Sessions en base, révocables** : token aléatoire 256 bits, seul son hash est stocké ;
  cookie `HttpOnly / Secure / SameSite=Lax` ; expiration glissante 14 jours avec **limite
  absolue** (défaut 90 j) pour interdire la prolongation infinie par activité.
- Guards sur `/admin/*` et tous les endpoints de mutation ; rate limiting PostgreSQL sur le
  login (défaut : 5 échecs / 15 min, par email et par hash d'IP, finalité anti-abus uniquement).
- Événements `admin.login` / `admin.logout` journalisés. « Déconnecter partout » = révocation
  de toutes les sessions.
- La conception n'empêche pas un 2FA futur (flux extensible), mais **rien n'est stocké** pour
  lui tant qu'il n'est pas demandé.

## 11. Stratégie médias

```text
Admin : demande d'URL d'upload (validation mime + taille)
  → ObjectStorage (port) → URL présignée
  → Browser → stockage objet directement (R2 en V1)
  → confirmation au serveur
  → vérification réelle de l'objet (HEAD : taille, mime) — on ne fait
    jamais confiance aux métadonnées du navigateur
  → media = processing
  → BackgroundJobs (port) → ImageTransformer (port)
  → variantes écrites dans le stockage → media = ready
```

- Cycle de vie explicite : `uploading → processing → ready | failed` ; un média `failed` est
  relançable depuis l'admin ; un cron balaye les `processing` bloqués (filet de sécurité).
- Adapter V1 des jobs : `waitUntil` côté Vercel — **`waitUntil` et Vercel restent confinés à
  l'adapter**, jamais dans le domaine média.
- `ImageTransformer` V1 : sharp (3-4 largeurs + AVIF/WebP). Remplaçable (service d'image,
  traitement au build) sans toucher aux repositories ni au domaine.
- V1 : les **images** suivent le pipeline complet ; les autres types (PDF, vidéo…) sont stockés
  et servis tels quels, sans variantes.
- Alt text requis pour insérer un média dans un contenu (accessibilité).
- CORS du bucket configuré pour l'upload direct ; le média est servi depuis le domaine de
  stockage/CDN, jamais depuis le domaine principal.

## 12. Stratégie de publication

- États : `draft | published`, soft delete (`deleted_at`).
- **Save** : enregistre, aucun effet public. **Publish** : validation complète du schéma,
  `published_at`, audit, rebuild. **Unpublish** : retour en draft, audit, rebuild.
- **Changement de slug d'un contenu publié** : création automatique d'une redirection
  permanente avec normalisation à l'écriture — `/a → /b` puis `/b → /c` donne `/a → /c` et
  `/b → /c` ; boucles interdites ; slug réapparaissant = conflit signalé ; suffixage `-2, -3`
  automatique à la création, slug toujours éditable ensuite.
- Les redirections sont matérialisées au build via un **port d'émission** (adapter Vercel :
  config plateforme). Rien n'est codé en dur pour Vercel dans le domaine.
- Déclenchements de rebuild rapprochés : coalescence naturelle côté plateforme (les builds
  supplantés sont annulés) ; pas de mécanique de debounce propriétaire en V1.

## 13. Formulaires publics

- V1 : **une capacité contact**, déclarée en code (`form_id`, schéma des champs, page de
  remerciement). Pas de form builder.
- Anti-spam en couches : honeypot, temps minimum de remplissage, rate limiting, Turnstile
  optionnel ; validation d'`Origin` sur les POST publics.
- Vie privée : **pas d'IP complète persistée** ; le rate limiting peut utiliser un hash d'IP à
  finalité anti-abus et à rétention courte ; l'UA brut n'est jamais stocké.
- `Mailer` : port minimal. **Aucun fournisseur obligatoire** — sans Mailer configuré, le
  formulaire fonctionne, la demande est stockée et visible dans l'admin, sans erreur
  fonctionnelle. Resend existe comme adapter d'exemple ; SMTP ou autres suivront
  indépendamment. L'échec d'envoi d'email est journalisé, jamais visible de l'expéditeur.

## 14. Analytics internes

- Collecte : beacon (`sendBeacon`/`fetch keepalive`) vers un endpoint contrôlé, sans cookie —
  pas de bandeau de consentement nécessaire.
- Événements V1 : `page_view`, `cta_click`, `contact_form_submitted`. Repoussés : scroll depth,
  form_started, heatmaps, parcours, fingerprinting, attribution.
- Session approximative : identifiant aléatoire éphémère en `sessionStorage`, sans donnée
  personnelle, usage analytics internes uniquement.
- Modèle : voir §7 ; géolocalisation et headers plateforme = enrichissements optionnels hors
  modèle Core ; device réduit à une classe.
- Rétention configurable + purge. Dashboard V1 : vues, sessions approximatives, top pages,
  top referrers, clics CTA, formulaires envoyés. Rien de plus.
- `/admin`, la preview et les appels invalides ne sont pas collectés.

## 15. SEO

- Par contenu : title, meta description, canonical (auto + override), OpenGraph, Twitter,
  **image sociale sélectionnable** dans la médiathèque, fallback OG défini par le
  projet/template.
- Au build : `sitemap.xml` (publics uniquement), `robots.txt` (admin et API exclus), JSON-LD
  approprié aux templates éditoriaux (helpers fournis par le Core, émission par les templates
  du projet).
- Redirections 301 issues de la table `redirects` matérialisées au déploiement.
- Repoussé : génération automatique d'images OG ; RSS (un type de contenu « feedable »
  générique ne se justifie pas tant qu'aucun projet n'en demande un — rien ne doit gêner son
  ajout ultérieur).

## 16. Sécurité

- **CSP sérieuse** : pas d'`unsafe-eval`, `unsafe-inline` réduit autant que raisonnablement
  possible, sources explicites. **Priorité aux APIs CSP natives d'Astro** : pas
  d'infrastructure maison de hash/nonces si Astro gère déjà correctement les scripts et
  styles générés ; les besoins spécifiques de Kreiz **complètent** la CSP native et ne la
  remplacent pas sans raison démontrée. Validée en implémentation contre les islands
  réellement utilisées — testée, pas supposée.
- En-têtes : HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors` (anti-
  clickjacking admin), Permissions-Policy.
- **CSRF** : token **lié à la session et vérifié côté serveur** sur toutes les mutations admin
  (pas de double-submit par convention), encapsulé dans le Core ; validation d'`Origin` sur les
  POST publics.
- Validation serveur systématique (Zod) de toute entrée, y compris `data` jsonb, payloads de
  formulaires et payloads analytics (taille bornée).
- Rate limiting PostgreSQL, opérations **atomiques et sûres sous concurrence serverless** ;
  pas de Redis en V1 ; externalisation en port si le volume le justifie un jour.
- Sessions et auth : cf. §10. Uploads : mime allowlist, taille bornée, vérification réelle de
  l'objet, médias servis hors du domaine principal.
- `admin_audit_log` append-only, sans IP complète. Secrets uniquement en variables d'env,
  aucun credential résiduel après bootstrap. `/admin` non indexé et sans lien public.

## 17. Tests

- **Unitaires (Vitest)** — fonctions déterministes uniquement : slug, route namespace,
  validation des schémas de contenu, sanitizer, résolveur/normalisation de redirections,
  guards purs, helpers SEO, fonctions analytics. Pas de couverture artificielle.
- **Intégration — Neon réel** : en CI, branche Neon temporaire : `créer → migrer → tester →
  détruire`. Vérifie le vrai driver et les vraies migrations.
- **E2E (Playwright)** — parcours critiques uniquement : login valide/invalide ; protection
  `/admin` ; création de contenu ; sauvegarde draft ; preview ; publication ; changement de
  slug + redirection ; formulaire de contact ; upload média (parcours nominal).
- **CI à niveaux, compatible open source** : lint / typecheck / unit / build tournent toujours
  (y compris PR de forks sans secrets) ; intégration Neon et E2E complets uniquement quand l'environnement
  CI autorisé dispose des secrets ; distinction documentée.

## 18. Structure du repository

```text
kreiz/
├── docs/                      # cadrage, architecture, guides (handoff)
├── packages/
│   └── core/                  # @kreiz/core  (lib + bin "kreiz")
│       └── src/
│           ├── domain/        # règles pures, types, schémas
│           ├── data/          # defineCoreTables + repositories
│           ├── services/      # publication, médias, formulaires, analytics, audit
│           ├── http/          # guards, CSRF, endpoints, intégration Astro (injectRoute)
│           ├── admin/         # shell admin, composants, islands Vue (Tiptap, picker)
│           ├── seo/
│           ├── ports/         # ObjectStorage, ImageTransformer, BackgroundJobs,
│           │                  # RebuildTrigger, Mailer
│           ├── adapters/      # vercel, s3/r2, resend (exemple), sharp
│           └── cli/           # bin kreiz (admin:create, admin:reset-password)
├── apps/
│   └── demo/                  # application de référence — consommateur EXTERNE du Core
│       ├── src/
│       │   ├── content-types/ # article, guide, case_study (déclarations)
│       │   ├── pages/         # routes publiques du projet
│       │   ├── templates/     # templates éditoriaux du projet
│       │   ├── styles/
│       │   └── schema.ts      # composition core + projet
│       ├── drizzle/           # chaîne de migrations (possédée par l'app)
│       └── package.json
├── pnpm-workspace.yaml
└── package.json
```

La frontière d'import est **mécaniquement appliquée** par la carte `exports` de
`@kreiz/core` : seuls les points d'entrée publics sont résolus, tout import profond échoue au
typecheck/build.

## 19. Frontière Core / Project

| Appartient au **Core** | Appartient au **Project** |
|---|---|
| Moteur éditorial, états, publication, slugs, redirects | Branding, design system final, navigation |
| Définitions de tables, repositories, guards, CSRF | Déclarations de types de contenu et de formulaires |
| Shell et composants génériques d'admin | Templates publics, wording, CTA |
| Ports + adapters de référence | Choix et configuration des adapters (bucket, rebuild, mailer) |
| Formulaires (capacité), analytics (3 événements), SEO (plomberie) | Tables satellites et types métiers |
| 404/500 par défaut, sitemap, robots | 404/500 personnalisés, contenu réel |

**Règle absolue** : le projet n'importe que l'API publique de `@kreiz/core`. Le demo est la
preuve continue de cette frontière.

## 20. Créer un nouveau projet (V1)

Procédure documentée, sans scaffolder : copier la structure de `apps/demo`, composer le
schéma, générer la migration initiale, déclarer ses types de contenu et ses formulaires,
écrire ses templates, configurer les env (Neon, bucket, hook de rebuild), créer le premier
admin via le CLI. Le scaffolder `create-kreiz-app` sera construit après le **deuxième vrai
projet consommateur**, quand ce qui est réellement répétitif sera connu — pas avant, pour ne
pas encoder des hypothèses fausses.

## 21. Décisions prises

1. Monorepo pnpm : `packages/core` + `apps/demo` (consommateur externe strict) + docs.
2. Rendu public statique + rebuild à la publication ; Save / Publish / Unpublish distincts ;
   échec de rebuild sans impact sur le site servi.
3. Vercel = cible de référence V1, derrière les ports `RebuildTrigger`, `BackgroundJobs`,
   `ObjectStorage`, `Mailer`.
4. `content_entries` générique + `data` JSONB typé par déclarations en code ; règle de
   promotion explicite vers colonnes/tables satellites ; pas de configuration depuis l'UI.
5. Article / Guide / Case Study sont des définitions de la démo, pas des tables du Core.
6. Neon + `@neondatabase/serverless` + Drizzle ; le Core exporte ses définitions de tables,
   les apps possèdent leurs migrations ; repositories comme unique frontière Drizzle.
7. Auth : argon2id, sessions DB révocables, cookie durci, rate limit, CLI `admin:create` /
   `admin:reset-password`, 14 j glissants + limite absolue ; pas de TOTP stocké.
8. Rich text : Tiptap en island, HTML sanitisé serveur = format canonique, éditeur remplaçable
   sans migration de contenu.
9. Médias : upload direct présigné V1, vérification serveur de l'objet, états
   `uploading/processing/ready/failed`, transformation asynchrone (sharp) via ports,
   retry admin + cron de rattrapage.
10. Slugs : `UNIQUE(route_namespace, slug)`, suffixage auto, slug éditable.
11. Redirections automatiques à changement de slug publié, normalisation des chaînes et
    boucles à l'écriture, matérialisation au build via port d'émission.
12. Preview SSR authentifiée réutilisant exactement les templates publics.
13. Contact déclaré en code ; honeypot + minimum-time + rate limit + Turnstile optionnel ;
    pas d'IP complète ; `Mailer` optionnel (Resend = adapter d'exemple).
14. Analytics : 3 événements, session anonyme `sessionStorage`, rétention configurable,
    dashboard minimal, enrichissements plateforme optionnels.
15. SEO complet au build (meta, sitemap, robots, JSON-LD) ; drafts/deleted/admin exclus.
16. Sécurité : CSP validée en implémentation, CSRF session-bound, rate limit PG atomique,
    audit log append-only, sobriété des données.
17. Tests : Vitest + branche Neon en CI + Playwright (9 parcours critiques) ; CI à niveaux
    compatible forks.
18. Un seul package `@kreiz/core` en V1 ; `draft | published` ; soft delete ; types déclarés
    en code ; routes admin injectées par l'intégration Astro du Core.

## 22. Décisions repoussées (avec motif)

| Repoussé | Motif de report |
|---|---|
| Publication npm / open source release | Aucun consommateur hors monorepo avant un vrai besoin |
| Scaffolder CLI | Après le 2e projet consommateur, sur ce qui sera réellement répétitif |
| RSS | Aucun projet ne l'a demandé ; pas de notion « feedable » générique prématurée |
| Images OG auto-générées | Valeur réelle non démontrée ; fallback par template suffit en V1 |
| 2FA active | Conception extensible, rien ne se stocke avant le besoin |
| Partage d'aperçu par token | Utile aux sites clients, pas bloquant pour la V1 |
| Publication planifiée, versioning, workflow avancé | Complexité éditoriale injustifiée aujourd'hui |
| Multi-rôles / permissions | Un seul rôle suffit ; les règles pures de guard facilitent l'ajout |
| SSR / rendu hybride du public | À réserver à un projet prouvant un besoin de temps réel |
| Redis / ports de rate limiting externes | PostgreSQL suffit au volume visé |
| Form builder, multilingue, moteur de thèmes, plugins, multi-tenant | Contraires aux principes (voir §4) |
| Tables satellites génériques | Construites par projet quand une règle de promotion l'exige |
| Médias vidéo avec pipeline | V1 : stockés/servis tels quels |

## 23. Défauts de travail validés

Ces valeurs sont fixées pour implémenter ; elles restent configurables par projet quand
c'est pertinent :

1. **Zod** pour la validation (schémas de contenu, formulaires, analytics, env).
2. **Node 24 LTS, Astro 7 (version stable courante à l'initialisation du repo), Tailwind 4.3,
   Vue 3, TypeScript strict** — la documentation référence la major supportée ; les versions
   exactes sont verrouillées dans le lockfile au slice 0.
3. **Préfixe `kreiz_`** sur les tables du Core, **non configurable en V1** — le nom des tables
   appartient au schéma et aux migrations de l'application ; un besoin réel de namespace
   configurable sera traité explicitement le moment venu.
4. Limite absolue de session : **90 jours**. Rétention analytics par défaut : **12 mois**.
5. Rate limits par défaut : login 5 échecs / 15 min ; formulaires ~5 / 10 min / hash d'IP.
6. Tailles upload : images ≤ 20 Mo ; variantes générées ≈ 400/800/1400/2000 px, AVIF + WebP.

## 24. Risques techniques

| Risque | Réalité | Mitigation |
|---|---|---|
| CSP × islands Astro | Friction réelle entre nonce/hash et scripts d'islands | Prototyper dès le premier slice admin ; tester, pas supposer ; garder `unsafe-inline` réduit mais pragmatique |
| Upload présigné + cycle de vie | Plus d'états et de filets qu'un upload par fonction | États explicites, vérification serveur, cron de rattrapage, retry admin, E2E nominal |
| sharp en fonction serverless | Bundle natif, cold start | Confiné à l'adapter ; job asynchrone (pas dans le chemin utilisateur) ; remplaçable par un service externe |
| Migrations possédées par les apps | Une évolution du Core impose une migration côté app | Changelog strict, tests d'intégration sur branche Neon incluant les upgrades |
| Frontière Core/Project qui fuit | Tentation d'import profond depuis la démo | Carte `exports` stricte, typecheck, revue de slice |
| Coupling au driver neon-http | Transactions et requêtes avancées ont leurs spécificités | Repositories comme unique point de contact ; besoins transactionnels encapsulés |
| Redirections multi-plateformes | Formats divergents (vercel.json, _redirects…) | Un seul adapter V1 ; port d'émission ; tests du résolveur pur |
| Rebuilds fréquents | Coût/latence si éditions très fréquentes | Coalescence plateforme ; acceptable pour le profil éditorial visé |
| Approximation analytics | Perte de beacons en fin de session | `sendBeacon`/`keepalive` ; hypothèse d'approximation assumée |
| Tiptap | Extensions pro payantes | Rester sur le cœur MIT ; le format canonique (HTML) rend l'éditeur remplaçable |

## 25. Ordre de construction recommandé

Slices verticales — chaque slice se termine par un demo qui n'utilise que l'API publique :

0. Squelette monorepo, tooling (TS strict, lint, Vitest), CI à niveaux, demo minimale
   **et spike de validation de l'intégration Astro** — sans admin ni logique métier, ce spike
   doit prouver que : (1) `apps/demo` installe et configure l'intégration `@kreiz/core` ;
   (2) le Core injecte une route de test via son API publique ; (3) cette route fonctionne
   en dev et au build avec l'adapter Vercel ; (4) une configuration fournie par `apps/demo`
   est accessible proprement à la route injectée (mécanisme tranché ici : virtual module,
   codegen ou autre) ; (5) aucun import profond n'est nécessaire ; (6) un import profond
   volontaire échoue au typecheck grâce à la carte `exports`. Ce spike valide la mécanique
   dont dépendra la preview : une route du Core doit consommer configuration et templates
   fournis par le Project sans dépendance inversée incorrecte.
1. Fondations data : `defineCoreTables`, connexion Neon, composition du schéma, première
   migration, repositories de base.
2. Auth + sessions + guards + CSRF + CLI `admin:create` + shell admin (login, layout, audit).
3. Moteur de contenu : déclarations de types, CRUD générique (champs simples), listing, slugs
   avec namespaces, preview SSR, Save draft.
4. Publication : Publish/Unpublish + `RebuildTrigger` + redirects normalisés + audit des
   actions + exclusion drafts/deleted du build.
5. Médias : `ObjectStorage` (R2), upload présigné, cycle de vie, `ImageTransformer` (sharp),
   `BackgroundJobs` (`waitUntil` + cron), media picker.
6. Rich text : island Tiptap + sanitizer allowlist + intégration dans l'éditeur de contenu.
7. Formulaires publics : contact, anti-spam, boîte admin, adapter Resend optionnel.
8. Analytics : collecte, purge, dashboard.
9. SEO & durcissement : sitemap, robots, JSON-LD, 404/500, en-têtes, CSP finale.
10. Tests E2E complets, documentation handoff, revue de la frontière Core/Project.

## 26. Prochaine étape

Cadrage validé (v1.1) — **slice 0 en cours** : squelette du monorepo, tooling, CI et spike
de l'intégration Astro.
