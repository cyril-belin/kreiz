# Slice 1 — Fondations data

Statut : **terminé — validé (PostgreSQL réel local + branche Neon dédiée)** · 2026-09-05

## Livré

- Les neuf tables Core V1 (`kreiz_*`, préfixe figé) définies dans `@kreiz/core`.
- `defineCoreTables()` — API publique de composition des tables.
- Couche de connexion serveur Neon HTTP + Drizzle, validation Zod de l'env.
- Trois repositories de domaine (admin users, contenus, redirections).
- Schéma composé de `apps/demo` (Core + table projet `demo_settings`).
- Première migration **possédée par `apps/demo`** (`apps/demo/drizzle/`).
- Tests unitaires (composition, env, frontière publique) et tests
  d'intégration réels contre PostgreSQL.
- CI : le job `integration` exécute maintenant le vrai cycle branche Neon
  éphémère (`créer → migrer → tester → supprimer`).

## Dépendances ajoutées

| Package | Version | Rôle |
|---|---|---|
| `drizzle-orm` | ^0.45.2 | ORM — dépendance de `@kreiz/core` **et** de `apps/demo` (même version → instance unique, verrouillée par le lockfile) |
| `@neondatabase/serverless` | ^1.1.0 | Driver HTTP Neon — dépendance de `@kreiz/core` uniquement |
| `drizzle-kit` | ^0.31.10 | Génération des migrations — devDependency de `apps/demo` |
| `pg` + `@types/pg` | ^8.23 | devDependencies de `@kreiz/core` — mode « PostgreSQL réel local » des tests d'intégration |

`zod` (déjà présent) valide l'environnement. Le driver HTTP Neon est la cible
V1 ; le navigateur ne parle jamais à Neon (aucun import data dans les
composants, les pages publiques ne requêtent pas la base).

## Architecture de connexion

```text
Astro/server (ou scripts de l'app)
   ↓
createKreizDatabase({ databaseUrl })      ← @kreiz/core/data (la seule porte Neon/Drizzle)
   ↓
repositories (factories créées par l'app avec l'instance db)
   ↓
Drizzle → @neondatabase/serverless → Neon PostgreSQL
```

- `@kreiz/core` ne lit jamais `process.env` de façon magique : l'application
  passe explicitement son environnement à `parseKreizDatabaseEnv(process.env)`
  (Zod : `KREIZ_DATABASE_URL` doit être une URL `postgresql://` / `postgres://`)
  puis appelle `createKreizDatabase({ databaseUrl })`.
- Le schéma n'est pas passé au client Drizzle : Kreiz utilise l'API core de
  Drizzle (`select`/`insert`) via ses repositories, pas l'API relationnelle
  `db.query.*`. La connexion n'ouvre rien à la création (driver HTTP, requête
  à l'usage).

## API publique data (`@kreiz/core/data`)

Nouveau sous-chemin de la carte `exports` (la frontière du slice 0 reste
intacte : `.`, `./data`, `./virtual`, `./package.json` — tout import profond
échoue toujours au typecheck).

- `defineCoreTables()` → les neuf tables, instances **singleton** (voir
  ci-dessous) ; type `CoreTables`.
- `createKreizDatabase({ databaseUrl })` → instance Drizzle typée
  `KreizDatabase` (driver HTTP Neon).
- `parseKreizDatabaseEnv(env)` / `kreizDatabaseEnvSchema` — validation Zod.
- `createAdminUsersRepository(db)`, `createContentEntriesRepository(db)`,
  `createRedirectsRepository(db)` et leurs types.
- Types de lignes et d'écriture dérivés des tables : `KreizAdminUser(Insert)`,
  `KreizContentEntry(Insert)`, `KreizRedirect(Insert)`, `KreizMedia(Insert)`,
  `KreizAdminSession(Insert)`, `KreizAdminAuditLog(Insert)`,
  `KreizContactRequest(Insert)`, `KreizAnalyticsEvent(Insert)`,
  `KreizRateLimit(Insert)` — plus les unions d'états
  (`KreizContentStatus`, `KreizMediaStatus`, `KreizContactRequestStatus`,
  `KreizAnalyticsEventName`, `KreizDeviceClass`) et `KreizContentSeo`,
  `KreizMediaVariant`.

Les objets tables eux-mêmes ne sont pas exportés individuellement : ils
s'obtiennent via `defineCoreTables()`, et les repositories couvrent l'accès
aux données. Cela évite deux chemins vers les mêmes tables.

### Fonctionnement de `defineCoreTables()`

Elle retourne un agrégat **gelé** de singletons de module : chaque appel
retourne les mêmes instances de tables. L'application qui compose son schéma
et les repositories du Core qui interrogent ces tables partagent donc
exactement les mêmes objets Drizzle — aucune instance incohérente possible.
C'est la raison documentée du choix « singleton » plutôt qu'une factory qui
recréerait les tables à chaque appel (cadrage §5 : éviter plusieurs instances
incohérentes ; §2.6 : pas d'abstraction sans besoin démontré).

## Composition Core + Project (`apps/demo`)

`apps/demo/src/schema.ts` :

```ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { defineCoreTables } from '@kreiz/core/data';

export const coreTables = defineCoreTables();
export const { adminUsers, …, rateLimits } = coreTables; // exports nommés directs
export const demoSettings = pgTable('demo_settings', { … }); // table projet
export const schema = { ...coreTables, demoSettings };       // schéma composé
```

`demo_settings` est explicitement une table de démonstration appartenant à
`apps/demo` — pas une fonctionnalité produit. Article/Guide/Case Study
restent des futurs types de contenu déclarés en code (slice 3), pas des
tables SQL.

Note d'implémentation : drizzle-kit collecte les **exports nommés directs**
du fichier de schéma ; d'où le décomposition `const { … } = coreTables()`.
Le schéma composé reste exporté (`schema`) pour l'application.

## Propriété des migrations

**Kreiz définit les tables, l'application possède les migrations.**

- `@kreiz/core` : aucune migration, aucun journal, aucune config drizzle-kit
  (garde par test : `packages/core/tests/data-public-api.test.ts`).
- `apps/demo` : `drizzle.config.ts` (schema = `./src/schema.ts`, out =
  `./drizzle`), dossier `drizzle/` avec le SQL + `meta/_journal.json`,
  script de migration via le migrateur Drizzle sur le driver Neon HTTP.

Commandes (depuis la racine) :

```sh
pnpm build          # le core doit être buildé : le schéma demo importe @kreiz/core/data
pnpm db:generate    # drizzle-kit generate — depuis le schéma composé de apps/demo
pnpm db:migrate     # applique apps/demo/drizzle sur $KREIZ_DATABASE_URL (driver HTTP Neon)
```

## Première migration (`apps/demo/drizzle/0000_*.sql`)

Contient, dans l'ordre : les dix CREATE TABLE (9 `kreiz_*` + `demo_settings`),
les 8 FOREIGN KEY explicites, puis les index. Applicable sur une base Neon
vide (validé sur PostgreSQL 18 local ; Neon = PostgreSQL géré, voir
« Validations »).

### Contraintes et index notables

- `kreiz_admin_users` : unicité `email`.
- `kreiz_admin_sessions` : unicité `token_hash` (seul le hash est stocké),
  index `admin_id` (révocation « déconnecter partout »).
- `kreiz_content_entries` : **unicité partielle** `(route_namespace, slug)`
  `WHERE deleted_at IS NULL` (un slug soft-deleted redevient disponible,
  sans collision avec un contenu actif) ; index
  `(content_type, status, published_at DESC)` et
  `(route_namespace, published_at DESC)` pour les listings/build.
- `kreiz_redirects` : unicité `from_path`.
- `kreiz_analytics_events` : index `(event_name, created_at)` et
  `(created_at)` (agrégats + purge par rétention).
- CHECK d'état matérialisés : `status` des contenus (`draft|published`),
  des médias (`uploading|processing|ready|failed`), des demandes de contact
  (`new|handled`), `event_name` et `device_class` analytics. `action` d'audit
  reste en texte libre (fermer le vocabulaire en base imposerait une
  migration à chaque nouvelle action).
- Pas d'IP complète ni d'UA brut nulle part.

### Règles `ON DELETE` (justifiées par le domaine)

| FK | Règle | Justification |
|---|---|---|
| sessions → admin | `CASCADE` | artefact éphémère, sans valeur sans son compte |
| audit → admin (acteur) | `RESTRICT` | l'historique append-only prime sur toute suppression |
| content.created_by/updated_by → admin | `RESTRICT` | même raison : références historiques |
| media.uploaded_by → admin | `RESTRICT` | idem |
| content.cover_media_id → media | `RESTRICT` | pas d'écrasement par effet de bord d'une couverture référencée (le média se retire en soft delete) |
| redirects.content_entry_id → content | `SET NULL` | la redirection (historique de navigation) survit à une purge du contenu |
| analytics.content_entry_id → content | `SET NULL` | la télémétrie agrégée ne bloque jamais une purge |

Conséquence assumée : un admin ou un média référencés ne peuvent pas être
supprimés physiquement — la désactivation (`disabled_at`) et le soft delete
sont les seules voies V1. `seo.og_image_media_id` reste une référence
logique dans le JSONB (pas de FK possible depuis un JSONB).

## Repositories (minimum du slice 1)

Trois repositories de domaine, factories injectées avec l'instance `db` —
pas de `BaseRepository` générique, pas d'`any` :

- `createAdminUsersRepository` — `create`, `findById`, `findByEmail` : prouve
  le cycle écriture/lecture typé du domaine auth (slice 2 l'étendra).
- `createContentEntriesRepository` — `create`, `findById`,
  `findActiveByNamespaceAndSlug` (filtre `deleted_at IS NULL`, même sémantique
  que l'index unique partiel).
- `createRedirectsRepository` — `create`, `findByFromPath` (lookup simple ;
  la normalisation des chemins restera une règle du domaine, slice 4).

Aucune méthode update/delete générique (dont l'audit append-only ne doit pas
souffrir). Pas de repository pour sessions, audit, médias, contact,
analytics, rate limits : leur logique métier appartient aux slices 2/4/5/7/8.
Le SQL brut (`db.execute`) n'apparaît que dans les tests, pour les
comportements PostgreSQL eux-mêmes et le nettoyage.

## Stratégie Neon dev / CI

- **Dev** : un projet/branche Neon dédié à Kreiz, URL dans `.env` (git-ignoré,
  voir `apps/demo/.env.example`). Aucun credential versionné, aucun seed.
- **CI** (`.github/workflows/ci.yml`, job `integration`) :
  1. gate `vars.RUN_INTEGRATION == 'true'` ;
  2. si secrets absents (PR de fork) : notice + succès — le job `quality`
     (lint · build · typecheck · unit) couvre toujours la PR ; aucun secret
     n'est élargi aux forks ;
  3. sinon : `neonctl branches create` → URL masquée (`::add-mask::`) →
     `pnpm --filter @kreiz/demo db:migrate` → `pnpm test:integration` →
     `neonctl branches delete` en `if: always()` (nettoyage même en échec).

Variables/secret GitHub requis : secret `NEON_API_KEY`, variable
`NEON_PROJECT_ID`, variable `RUN_INTEGRATION=true`.

## Variables d'environnement

| Variable | Où | Rôle |
|---|---|---|
| `KREIZ_DATABASE_URL` | `.env` local / env CI | URL PostgreSQL Neon consommée par les scripts db:* et les tests d'intégration |

## Validations réellement exécutées

- `pnpm lint` ✅ · `pnpm build` ✅ (core tsc + demo astro build, adapter
  Vercel) · `pnpm typecheck` ✅ (tsc + astro check, 0 erreur) · `pnpm test`
  ✅ (23 tests unitaires ; intégration sautée sans env).
- **Tests d'intégration sur PostgreSQL 18.6 réel** (cluster local jetable) :
  **25/25 ✅**, sur base vide (migration appliquée puis vérifiée :
  tables, colonnes/nullabilité, règles ON DELETE, index — dont l'unicité
  partielle) et sur base déjà migrée ; données de test isolées par run et
  nettoyées (0 ligne résiduelle vérifiée en base).
- **Chemin canonique Neon HTTP validé** sur la branche Neon de développement
  dédiée à Kreiz (endpoint pooler, eu-central-1, PostgreSQL 18.6) :
  `parseKreizDatabaseEnv()` → `createKreizDatabase()` →
  `@neondatabase/serverless` (harnais en mode `neon-http` confirmé, `$client`
  = fonction neon, jamais `pg`) → migrateur `drizzle-orm/neon-http/migrator`
  sur base vide (10 tables créées, idempotent au re-run) → **25/25 tests
  d'intégration ✅ en mode `KREIZ_DATABASE_URL`** (stabilité : 5/5 runs
  verts consécutifs) → **0 ligne résiduelle** vérifiée sur les dix tables.
  FK (23503/23001), CHECK, unicité email et `from_path`, unicité partielle
  `(route_namespace, slug)` avec libération après soft delete,
  CASCADE/RESTRICT/SET NULL et write→read via les repositories publics sont
  donc vérifiés sur Neon même.
- Comportements vérifiés en base réelle (local **et** Neon) : unicité email
  et `from_path` ; unicité partielle `(route_namespace, slug)` avec
  libération après soft delete ; CHECK d'état ; FK (référence inconnue →
  23503, suppression RESTRICT bloquée → 23001, CASCADE sessions, SET NULL
  redirects/analytics) ; NOT NULL essentiels ; write→read typé via les
  repositories publics.

### Job CI Neon (pas encore exécutable avant commit/push)

Le cycle `créer branche éphémère → migrer → tester → supprimer` est en place
dans le workflow mais nécessite le commit/push du slice (le fichier de
workflow doit être sur `main` pour être déclenchable) et les secrets GitHub :
secret `NEON_API_KEY`, variables `NEON_PROJECT_ID` et `RUN_INTEGRATION=true`.
Le parsing de la sortie `neonctl branches create --output json` a été vérifié
contre la source de neonctl 4.14.1 (`connection_uris[0].connection_uri`) et
corrigé en conséquence avant tout run.

## Décisions et écarts au cadrage

- **Singleton de tables** (voir `defineCoreTables`) : préféré à une factory
  instanciable, pour l'unicité des instances ; l'API demandée reste identique.
- **JSONB en camelCase** (`seo`, `variants`, `data`) : consommés par le TS
  applicatif, pas interrogés en SQL brut — cohérents avec les futures
  déclarations Zod de types de contenu.
- **CHECK sur les états fermés** (`status`, `event_name`, `device_class`),
  pas sur `action` d'audit (vocabulaire croissant slice après slice).
- **`referrer` analytics nullable** : NULL = accès direct ; les colonnes
  nullable listées par la mission le restent (`width`/`height` sans
  dimensions, `failure_reason`, `deleted_at`…).
- **`size_bytes` en bigint** (mode number) : marge au-delà des 20 Mo d'images.
- **Export nommé direct des tables dans le schéma demo** : contrainte
  pratique de drizzle-kit (collecte des exports nommés), documentée dans
  `apps/demo/src/schema.ts`.
- **Mode « PostgreSQL réel local » des tests** (`KREIZ_TEST_DATABASE_URL`) :
  ajoute une voie de validation de la sémantique SQL sans Neon (utile aux
  contributeurs et à la revue) — le mode canonique reste Neon HTTP, et le
  statut de validation ci-dessus distingue explicitement les deux.
- **Verrou consultatif** dans le harnais de tests locaux : les fichiers
  Vitest parallèles appliquent la migration en exclusion mutuelle (la CI
  Neon n'en a pas besoin : migration appliquée en étape dédiée avant les
  tests).
- **Erreurs réseau transitoires Neon** (constatées en réel) : les connexions
  HTTPS vers Neon échouent occasionnellement (`UND_ERR_CONNECT_TIMEOUT`,
  fetch failed) — surtout à froid et sous charge locale. Pris en compte
  uniquement côté harnais/scripts, jamais dans le Core : timeouts Vitest
  relevés (30 s/test, 60 s/hooks — chaque requête est un aller-retour HTTPS
  vers une région distante), retry borné (3 essais) sur ces seules erreurs
  réseau dans l'exécuteur du harnais, les appels de repositories du setup et
  le script `db:migrate`. Les erreurs SQL ne sont jamais retentées. La
  stratégie applicative (retry/idempotence dans les services) appartient aux
  slices suivants.

## Frontière slice 0 — inchangée

Intégration Astro, `injectRoute`, `virtual:kreiz/config`, carte `exports`
restrictive (étendue de `./data` uniquement), demo consommateur externe,
build Vercel, Tailwind, CI quality : tout est conservé ; la route spike
reste en place. Garde anti-régression : `data-public-api.test.ts` vérifie
les clés exactes de la carte `exports`.
