# Slice 8 — Analytics privacy-first

Statut : **terminé — en attente de revue**, 2026-09-16, base `main = 6e19cb9` (« feat: add public contact forms with layered anti-spam and mailer port »).

## Livré

- **Primitive Core, zéro fournisseur** — aucune dépendance nouvelle, aucun SDK tiers, aucun appel sortant : le domaine (`domain/analytics/`), la persistance (`kreiz_analytics_events`), la collecte et le dashboard appartiennent entièrement au Core. Les Projects activent, bornent ou coupent la mesure **en code** (`kreiz({ analytics: … })`) ; ajouter plus tard un adaptateur externe reste possible sans toucher au domaine (types/ports propres, vocabulaire fermé exporté).
- **Beacon minuscule, statique au build** — `/api/analytics/beacon.js` est une route **prérendue** : un fichier statique servi par le CDN (1980 B brut, **886 B gzip**), aucun runtime dynamique, aucune lib, aucun domaine tiers, aucun JS ajouté au bundle public du Project (un `<script defer>` externe, posé via le helper `analyticsBeaconScript()`). Le beacon est un **capteur muet** : session éphémère en `sessionStorage`, gestion du prerender (`prerenderingchange` — mesure à l'activation, pas au crawl), `sendBeacon` avec repli `fetch keepalive`, DNT/GPC vérifiés client (aucune requête du tout), CTA opt-in par attribut `data-kz-cta` (`analyticsCtaAttributes()`).
- **Endpoint public borné** — `POST /api/analytics/event` (hors `/admin`, sans session admin, garde mécanique `PUBLIC_ROUTE_PATTERNS`) : JSON strict ≤ 2 KiB (garde sur `Content-Length` **et** corps lu), schéma Zod `strict` à structure fermée (clés inconnues rejetées), réponses **toujours muettes** (204 stocké/doublon/ignoré, 400 illisible, 403 origine croisée, 429 + `Retry-After` — aucun corps, aucun écho du payload, jamais un oracle). Désactivé (`analytics.enabled: false`), l'endpoint ne stocke rien et la route beacon sert un stub vide.
- **Politique serveur intégrale** — le serveur décide tout : activation, signaux de vie privée, filtre de bots, préfetch, chemins exclus, rate limiting, déduplication, résolution de contenu. Le client ne peut ni élargir une borne, ni créer un nom d'événement, ni injecter une propriété.
- **Conversions serveur (réutilisation slice 7)** — le service contact émet `form_accepted` quand une soumission est **réellement acceptée et persistée**, et `form_notification_sent` à la livraison effective. Aucune donnée visiteur n'y entre (clé de formulaire, chemin referer same-origin normalisé, horodatage). Un échec de mesure est **avalé** : l'analytics ne casse jamais le produit. Analytics ≠ audit : la traçabilité opérationnelle reste dans `kreiz_admin_audit_log`.
- **Dashboard admin** — `/admin/analytics` (nav « Analyse → Analytics » activée) : totaux (pages vues, sessions approximatives, formulaires acceptés, clics CTA), séries journalières **en CSS pur** (aucune lib de charts), top pages / sources externes / campagnes UTM / conversions par formulaire, périodes 7/30/90 jours. Toute agrégation est un `GROUP BY` SQL borné — **aucun événement chargé en mémoire**. La consultation purge **opportunistement** au-delà de la rétention (pas de scheduler obligatoire).
- **Démo** — balise beacon posée sur les 6 pages publiques, config analytics explicite dans `astro.config.ts`.

## Dépendances ajoutées

**Aucune.** L'ensemble (parsing Zod, HMAC du secret existant, rate limiting PostgreSQL, Drizzle) réutilise ce qui est déjà là.

## Migration

`apps/demo/drizzle/0005_soft_phantom_reporter.sql` (appartenant à l'app, générée par drizzle-kit) — **purement additive**, sur `kreiz_analytics_events` (table posée au slice 1, vide par construction : aucun collecteur n'existait) :

- colonnes `referrer_kind`, `locale`, `utm_source/medium/campaign/content/term`, `dedup_key` (toutes nullables) ; `session_id` passe à **nullable** (conversions serveur sans session navigateur) ;
- CHECK `event_name` remplacé : vocabulaire fermé slice 8 (`page_view`, `cta_click`, `form_accepted`, `form_notification_sent`) — l'ancien `contact_form_submitted` disparaît, impossible en base puisqu'aucune ligne ne pouvait exister ;
- CHECK `referrer_kind in ('internal','external')` ;
- **bornes de longueur en base** (path ≤ 512, referrer ≤ 253, session ≤ 64, locale ≤ 35, utm ≤ 128, dedup_key ≤ 700) — filet de sécurité derrière la validation applicative, car l'endpoint est public par nature ;
- index unique **partiel** `kreiz_analytics_events_dedup_key_unique` (`WHERE dedup_key IS NOT NULL`), même arbitre concurrentiel que les demandes de contact.

Testée sur **PostgreSQL réel** : branche Neon migrée (`pnpm db:migrate`, appliqué en réel avant les tests) **et** rejeu de l'historique complet `0000 → 0005` dans un schéma isolé (`tests/integration/analytics-migration.test.ts` : colonnes/nullabilités, vocabulaire fermé appliqué en base, unicité partielle 23505, bornes CHECK 23514, index de lecture/purge conservés).

## Architecture

```
Page statique du Project (build)
  → <script defer src="/api/analytics/beacon.js">   (fichier prérendu, CDN)
      beacon : session sessionStorage + UTM location.search + document.referrer
      → POST /api/analytics/event (SSR, hors /admin)
  → route : Origin/Sec-Fetch → content-type JSON → borne 2 KiB → JSON.parse
  → service analytics (politique serveur) :
      disabled → DNT/GPC → préfetch → bots (UA minimal) → parse whitelist
      → chemin exclu → rate limit (hash d'IP, 30/60 s) → résolution contenu
      → INSERT … ON CONFLICT DO NOTHING (dedup_key, tranche 30 s)
  → 204 muet (ou 400/403/429)

Service contact (slice 7) — acceptation → form_accepted ; notification → form_notification_sent

Admin : /admin/analytics (session) → agrégations SQL (6 requêtes bornées)
  → séries journalières CSS + tops + conversions ; purge opportuniste
```

### Fichiers créés / modifiés (Core)

Créés :
- `src/domain/analytics/policy.ts` — vocabulaire fermé (client vs serveur), bornes, normalisation (chemin/query-stripping, referrer→domaine, UTM, locale, session UUID strict, CTA), chemins exclus par défaut, filtre de bots minimal, préfetch, DNT/GPC, rate limiting, dédup 30 s, rétention, buckets UTC ;
- `src/domain/analytics/config.ts` — schéma de déclaration Project + résolution (défauts privacy-safe) ;
- `src/domain/analytics/collect.ts` — parseur beacon (whitelist stricte, zod strict discriminé) ;
- `src/analytics/beacon-source.ts` — source du beacon (pure, paramètre `enabled`) + `analyticsBeaconScript()` ;
- `src/analytics/collect.ts` (route publique POST), `src/analytics/beacon.ts` (route prérendue), `src/analytics/cta.ts`, `src/analytics/runtime.ts`, `src/analytics/index.ts` (API publique `@kreiz/core/analytics`) ;
- `src/data/repositories/analytics-events.ts` — insert `ON CONFLICT DO NOTHING`, résolution contenu publié, purge, 5 agrégations SQL ;
- `src/services/analytics.ts` — collecte (politique), conversions serveur, rétention, dashboard ;
- `src/admin/pages/analytics.astro`.

Modifiés : `config.ts` (section `analytics` revalidée, toujours résolue ; type d'entrée `KreizConfigInput` partiel), `data/tables/analytics-events.ts` (colonnes slice 8), `services/contact.ts` (récepteur analytics optionnel + `analyticsPage`), `http/admin-runtime.ts` (service analytics + câblage contact), `http/admin-routes.ts` (+1 page admin, +2 routes publiques gardées), `http/server-env.ts` (aucun changement — **aucune variable d'environnement nouvelle**), `integration.ts` (+3 routes injectées), `AdminShell.astro` (nav), `admin/pages/index.astro` (texte dashboard), `admin/styles/admin.css` (stats/bars), `package.json` (export `./analytics`), `index.ts` (`KreizConfigInput`). Démo : `astro.config.ts`, 6 pages publiques (beacon), `e2e/analytics.spec.ts`, `e2e/global-teardown.ts`.

## Modèle de données

`kreiz_analytics_events` : `id`, `event_name` (vocabulaire fermé CHECK), `path` (pathname seul), `referrer` (domaine normalisé, NULL = direct), `referrer_kind` (`internal|external|NULL`), `session_id` (UUID éphémère par onglet, nullable), `content_type` + `content_entry_id` (FK SET NULL — la télémétrie survit à une purge de contenu), `device_class` (classe grossière dérivée à la volée), `country` (**non rempli en V1** — enrichissement plateforme réservé), `locale`, 5 colonnes UTM, `metadata` (JSONB construit serveur : `form` ou `cta`), `dedup_key`, `created_at` (timestamptz). Index : `(event_name, created_at)` lecture, `(created_at)` purge, unique partiel `dedup_key`.

## Modèle de confidentialité (définition exacte de « ce qui est stocké »)

**Stocké :** chemin de page (query et fragment systématiquement strippés), domaine du referrer externe, UUID de session éphémère, classe d'appareil (mobile/tablet/desktop, dérivée à la volée), tag de langue, 5 champs UTM normalisés, identifiant de CTA ou clé de formulaire, horodatage UTC.

**Jamais stocké :** adresse IP (pas même en HMAC persistant — l'IP ne sert qu'à la clé de rate limiting HMAC éphémère, même dérivation que le login, puis est jetée), User-Agent brut, URL complète ou query arbitraire (tokens, emails, termes de recherche), cookies publicitaires, empreinte navigateur, identifiant persistant cross-site, contenu de formulaire, email, PII métier. Les logs ne contiennent rien de tout cela (l'endpoint ne journalise pas du tout en V1).

**Session (définition) :** un UUID aléatoire par **onglet** de navigateur (`sessionStorage`, supprimé à la fermeture) — « une session » = un onglet en navigation continue ; deux onglets comptent deux sessions, une fermeture puis un retour en compte une nouvelle. Aucune prétention d'exactitude : mesure approximative assumée, sans identité durable, sans cross-site, sans cookie. La colonne accepte NULL (conversions serveur).

**DNT / GPC (politique conservative explicite) :** `DNT: 1` ou `Sec-GPC: 1` sur la requête ⇒ **aucune collecte** (204 sans stockage), quand `respectPrivacySignals: true` (défaut). Le beacon évite même la requête quand le navigateur expose le signal.

**Consentement :** le mode V1 fonctionne **sans cookie et sans PII** — pas de bannière requise pour cette mesure (documenté, pas de CMP construite). `respectPrivacySignals: false` reste un choix Project explicite et validé.

**Bot filtering (minimal, documenté) :** ~16 marqueurs d'UA évidents (crawl/bot/headless/monitoring…), préfetch/prerender (`Sec-Purpose`, `Purpose`, `X-Moz`), HEAD refusé (POST seul). Un peu de bruit est accepté plutôt qu'un filtre fragile ; pas de base d'UA. Les navigateurs headless sont exclus **serveur** — c'est pourquoi l'E2E mesure avec un UA de visiteur réel.

## Collecte pageview / événements / UTM / referrer

- **Page views** : beacon sur pages statiques (approche B, quasi invisible) ; en-tête `data-kz-cta` pour les CTA. Le serveur résout le chemin vers le contenu publié (1 requête indexée, au plus) pour la performance de contenu.
- **Événements** : vocabulaire **fermé** — le client ne peut émettre que `page_view` et `cta_click` ; `form_accepted` / `form_notification_sent` sont réservés au serveur (rejetés du endpoint public). Cardinalité bornée par construction ; `metadata` construite serveur uniquement.
- **UTM** : 5 champs whitelistés, trim + minuscules + espaces collapses + contrôle interdits + borne 128. **Query stripping** : aucun autre paramètre n'est jamais stocké.
- **Referrer** : réduit au domaine (`google.com`, jamais l'URL complète) ; classé `internal` (même hôte ou domaine déclaré interne) / `external` ; NULL = direct. Les sources internes n'apparaissent jamais dans « top sources ».
- **Déduplication** : clé serveur `(session, événement, chemin, tranche de 30 s)` sur index unique partiel — double beacon, retry réseau et rechargement < 30 s comptent une fois ; au-delà, un rechargement est légitimement recompté (fenêtre documentée, précision non visée).

## Rétention

`retentionDays` Project (7–365, défaut 90) ; purge `DELETE WHERE created_at < cutoff` (index dédié), déclenchée opportunistement à l'ouverture du dashboard admin et exposée au service (`analytics.runRetention()`) pour un cron futur — aucun scheduler imposé.

## Anti-abus

Rate limiting PostgreSQL existant (réutilisé, pas dupliqué) : 30 événements / 60 s par hash d'IP HMAC — compté **avant** tout stockage, le coût des requêtes hostiles est plafonné ; 429 muet + `Retry-After`. Payload ≤ 2 KiB, schéma fermé, vocabulaire fermé, bornes de longueur **redondées en CHECK SQL**. Origine croisée refusée (même garde que les POST de formulaires). Sessions UUID strictes : une charge forgée devient `NULL` (jamais du texte arbitraire en base).

## Sécurité (scénarios hostiles testés)

HTML/script dans le chemin (stocké comme donnée paramétrée, échappé au rendu), clés prototype-like, JSON nesting, clés inconnues, nom d'événement inventé ou réservé serveur, path CR/LF, chemin `/admin` forcé, session forgée, referrer spoofé (réduit au domaine), UTM géants, SQL-ish strings (requêtes paramétrées), payloads > 2 KiB (rejetés sur `Content-Length` **puis** sur le corps lu) : aucun 500, aucune ligne non conforme, aucun écho, aucune fuite log.

## Tests

- **Unitaires** (+60, `packages/core/tests/analytics-*.test.ts`) : politique (chemin/query, referrer/classification, UTM/locale/session/CTA, exclusions, bots/préfetch/DNT-GPC, dédup, buckets UTC), config (défauts, rétention 7–365, préfixes/domaines invalides, clés inconnues), parseur (valides, whitelist stricte, bornes de lecture, hostiles), service (politique complète, rate limit, dédup, conversions avalées, rétention, dashboard), beacon (garde-fous, poids < 2 Ko, stub désactivé, helpers). Suite complète : **509 verts**.
- **Intégration PostgreSQL réel** (+18) : write→read typé, dédup (même tranche/tranche suivante), 25 inserts concurrents, **purge+agrégations pendant inserts**, purge par rétention, séries journalières UTC 7/30/90, top pages/referrers/campagnes, conversion `form_accepted`, chemins exclus absents en base, **absence structurelle de PII** (la ligne complète ne contient ni IP ni UA ni query), FK `content_entry_id` SET NULL, migration rejouée `0000 → 0005` en schéma isolé. Suite : **119 verts** sur Neon.
- **E2E Playwright** (+10) : page publique → page view collectée ; `/admin` et `/admin/preview` → zéro page view ; UTM normalisés ; DNT → zéro collecte ; formulaire accepté → conversion **sans aucune donnée du formulaire** (email/marqueurs absents de la ligne complète) ; double beacon → dédupliqué ; payloads hostiles → muets et sans ligne ; rafale → 429 + `Retry-After` ; dashboard admin gardé et **cohérent au compteur réel près** (période 7 j). Suite complète : **68 verts**.

## Build Vercel & performance

Build réel vert (adapter Vercel, `output: static`) : les pages publiques restent **statiques** (`index.html`…), la route beacon est un **fichier statique** (`static/api/analytics/beacon.js` — jamais une fonction), `/api/analytics/event` et `/admin/analytics` sont les seules entrées serverless (vérifié dans `.vercel/output/config.json`), **aucun secret dans la sortie publique**, aucune dépendance analytics externe. Poids mesurés : beacon **1980 B / 886 B gzip** ; JS ajouté au bundle public du Project : **0 octet** (tag externe). Coût par page vue acceptée : 3 requêtes SQL (upsert rate limit, lookup contenu indexé, insert). Dashboard : 6 agrégations SQL bornées (GROUP BY + LIMIT 10) servies par les index `(event_name, created_at)`/`(created_at)`.

## Décisions

- **Session `sessionStorage` plutôt que HMAC(IP+UA+bucket)** : le cadrage slice 1 avait fixé ce design dans la table ; il est plus simple **et** plus privé (aucune donnée dérivée d'IP n'est jamais stockée), au prix d'une précision approximative assumée et documentée. La mission autorise explicitement l'alternative plus cohérente.
- **Conversions serveur uniquement** (`form_accepted` à l'acceptation persistée, pas au POST brut) : les soumissions client sont du bruit amplifiable (bots) ; la conversion honnête est côté serveur.
- **Vocabulaire fermé** remplaçant le `contact_form_submitted` du cadrage : aligné sur les noms du slice 8 (`form_accepted`), sans migration destructrice (table vide par construction).
- **Réponses muettes partout** : un endpoint analytics ne doit être ni un oracle ni un journal.
- **Bornes de longueur en CHECK SQL** (nouveau dans le schéma) : l'endpoint est public par nature — le filet de sécurité base justifie l'exception aux slices précédentes.
- **`country` non rempli en V1** : la mission ne le demande pas ; la colonne du cadrage reste réservée, documentée.
- **Beacon muet** : pas de filtrage bot client (l'UA headless est filtré serveur) — le beacon reste un capteur, la politique reste serveur.

## Écarts assumés et risques reportés

- **Scénario E2E « analytics disabled »** : la config est résolue au build (statique-first), le serveur E2E tourne avec la démo activée — le mode désactivé est couvert **unitairement** (endpoint muet, service `ignored: disabled`) **et** par le test du stub beacon servi quand `enabled: false` ; un second serveur E2E par config n'aurait rien prouvé de plus.
- **Purge opportuniste** (dashboard) : recommander un cron en production pour une rétention stricte indépendante des visites admin.
- **Pas de dashboard par contenu typé** (drill-down par `content_type`) : les ids sont stockés, l'agrégation est reportée à un besoin démontré.
- **Pas de logs structurés de rejet** : aucun log du tout en V1 (le plus sûr anti-fuite) ; une raison bornée pourra être ajoutée derrière un `reject-reason` anonyme si le besoin apparaît.
- **Flakiness préexistant corrigé au passage** : `admin-auth.test.ts > resolveSession (touch)` comparait deux lectures Neon à la milliseconde (échec 2/4 runs **sur l'arbre propre à HEAD** avant tout changement slice 8) — la comparaison porte désormais sur l'horodatage reculé en base par l'UPDATE (`returning last_seen_at`), déterministe.

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc + astro check, 0 erreur) · `pnpm build` ✅ (core + démo, adapter Vercel).
- `pnpm test` ✅ **509 verts** (unitaires ; intégration ignorée sans env).
- `pnpm test:integration` ✅ **120 verts** sur Neon réel (branche de dev migrée 0005 ; données de test isolées par run et purgées).
- `pnpm test:e2e` ✅ **68 verts** (dont 10 analytics, rejoués 3× pour la stabilité) — nettoyage final : **zéro ligne résiduelle** sur les 10 tables (vérifié en base après run).
- Auto-revue hostile (18 points de la mission §42) — **5 constats réels, tous corrigés** :
  1. *chemins exclus sensibles à la casse* (`/Admin/…` aurait été compté) → comparaison de préfixes insensible à la casse + test ;
  2. *lecture du corps non plafonnée en streaming* (un corps géant sans `Content-Length` aurait été bufferisé avant mesure) → lecture plafonnée avec `reader.cancel()` au-delà de 2 KiB ;
  3. *buckets journaliers dépendant du fuseau de la session PostgreSQL* (`date_trunc` tronque dans le fuseau courant) → `timezone('UTC', created_at)::date::text` — jour explicite, indépendant de la config serveur, sans re-parse ambiguë côté Node ;
  4. *garde `navigator.webdriver` du beacon* : elle empêchait toute mesure sous automatisation alors que le filtrage bot est une politique **serveur** (UA headless déjà filtré) → beacon ramené à un capteur purement muet, l'E2E mesure avec un UA de visiteur réel ;
  5. *marqueur email E2E hors pattern de nettoyage* (`e2e8-…` ne matchait pas `e2e-%`) → marqueur réaligné, 6 lignes résiduelles de mes runs purgées, teardown vérifié à zéro. Le test de déduplication encode désormais explicitement la politique de frontière de tranche (2 lignes uniquement si la paire chevauche 30 s).
