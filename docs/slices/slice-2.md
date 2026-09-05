# Slice 2 — Authentification admin, sessions, guards, CSRF, CLI et shell `/admin`

Statut : **terminé — en attente de revue** · 2026-09-05

## Livré

- Authentification admin complète (email + mot de passe **Argon2id**, sessions
  serveur révocables en base, cookie durci).
- Guards admin réutilisables, CSRF session-bound, protections
  same-origin/Fetch Metadata, rate limiting PostgreSQL du login, journal
  d'audit **append-only**.
- CLI `kreiz` (`admin:create`, `admin:reset-password`) — le bin prévu par le
  cadrage est réellement implémenté.
- Shell `/admin` SSR (layout, navigation, identité, logout) + `/admin/login`
  fonctionnant sans JavaScript.
- E2E Playwright des parcours critiques, tests d'intégration Neon étendus,
  CI ouverte à l'E2E sans sacrifier la compatibilité forks.

## Dépendances ajoutées

| Package | Version | Rôle |
|---|---|---|
| `@node-rs/argon2` | 2.2.0 | Hachage Argon2id — dépendance de `@kreiz/core` **et** de `apps/demo` (même logique que `drizzle-orm` au slice 1 : instance unique, et le traceur de dépendances Vercel ne résout le binaire natif que depuis les `node_modules` de l'app) |
| `@playwright/test` | ^1.63.0 | E2E — devDependency de `apps/demo` |
| `pg` + `@types/pg` | ^8.23 | devDependencies de `apps/demo` — accès DB de l'infrastructure E2E (états + nettoyage uniquement) |

**Pourquoi `@node-rs/argon2`** : binding NAPI-RS d'argon2-rust, binaires
précompilés pour les plateformes cibles (pas de `node-gyp` ni de
`build-from-source` en serverless), bibliothèque maintenue et massivement
éprouvée (écosystème Lucia/better-auth). Le paquet `argon2` natif exige un
rebuild à la source sur Vercel ; les alternatives WASM (hash-wasm) sont
4× plus lentes sans avantage ici. Compatibilité Vercel **prouvée au build
local** : le binaire `.node` est tracé dans
`.vercel/output/functions/_render.func/node_modules/.../@node-rs/argon2-*/`.

## Architecture

```text
CLI kreiz (admin:create / admin:reset-password)          Navigateur
        ↓                                                 /admin/login
   services/admin-auth.ts  ←── composition root ──→  http/server-env.ts
        ↓                                    (getKreizAdminRuntime, memoïsé)
   data/repositories (admin-users, admin-sessions,
   admin-audit-log, rate-limits) — seule frontière Drizzle
        ↓
   Neon PostgreSQL (kreiz_admin_users, _sessions, _audit_log, _rate_limits)
```

- **domain/auth.ts** — règles pures sans I/O : politique de mot de passe,
  normalisation email, schéma Zod du login, fenêtres d'expiration
  (14 j / 90 j / seuil de touch), format des clés de rate limiting.
- **services/** — `password.ts` (Argon2id + « appeau » anti-énumération),
  `auth-tokens.ts` (crypto : token, hash, CSRF dérivé, HMAC d'IP),
  `admin-auth.ts` (orchestration login/session/logout/create/reset/disable).
- **http/** — `server-env.ts` (env runtime + composition root memoïsée),
  `guards.ts`, `csrf.ts`, `mutations.ts`, `cookies.ts`,
  `security-headers.ts`, `admin-login.ts`.
- **admin/** — pages `.astro` (login, shell), endpoint logout, CSS autonome.
- **cli/** — `kreiz.ts` (bin, parsing, I/O), `commands.ts` (logique sans
  TTY), `prompts.ts` (terminal masqué via mode raw).

Le domaine et les services ne connaissent ni Astro ni le driver Neon ;
les guards ne requêtent jamais Neon directement (ils reçoivent le service).
Le Core lit `process.env` **uniquement** dans `http/server-env.ts`, via le
schéma Zod public (`parseKreizAdminEnv`) — même discipline que le slice 1.

## Politique mot de passe (documentée)

- **Longueur minimale 12**, maximale 128 — pas de règles de composition
  artificielles (pas de majuscule/symbole obligatoire, cadrage §10/NIST
  SP 800-63B).
- Refus des valeurs manifestement inadéquates : correspondance exacte
  (marches de clavier, variantes usuelles) et « cœurs » compromis
  (`password`, `motdepasse`, `admin`…) suivis de chiffres uniquement.
  Comparaison insensible à la casse. Ce n'est pas un filtrage HIBP.
- Refus d'un mot de passe contenant le local-part de l'email (≥ 3 caractères
  pour éviter les faux positifs absurdes type `a@…`).
- **Argon2id, paramètres OWASP 2024 explicites** : m = 19456 KiB, t = 2,
  p = 1, sel 16 octets généré par la bibliothèque, chaîne PHC complète
  stockée dans `kreiz_admin_users.password_hash` (jamais le mot de passe
  brut, jamais le hash loggué).

## Format du token de session et hashing

- Token brut : **32 octets `crypto.randomBytes`** (256 bits d'entropie),
  encodés base64url (43 caractères).
- Stockage : **SHA-256 hex** du token (`token_hash`, unicité en base).
  Le SHA public est sans risque ici précisément parce que l'espace de
  tokens est de 256 bits (imprécalculable) — c'est la pratique Lucia/Oslo.
- Le token brut ne vit **que** dans le cookie ; jamais persisté, jamais
  loggué, jamais rendu au navigateur.

## Cookie

- Nom : `kreiz_admin_session` (namespacé Kreiz).
- `HttpOnly` (jamais accessible au JS, rien dans localStorage/sessionStorage),
  `SameSite=Lax`, `Secure` en production uniquement, `Path=/admin` (le
  cookie n'est plus envoyé sur le site public), `Max-Age` aligné sur
  `expires_at` de la session — rafraîchi quand la glissière est prolongée.
- Invalidation : suppression côté serveur à chaque réponse de logout/refus.

### Invariant de namespace — routes authentifiées sous `/admin/*`

Le bénéfice de sécurité de `Path=/admin` (le cookie admin ne part jamais
avec les requêtes du site public) impose une **règle explicite pour tous
les slices futurs** :

> **Toute route nécessitant la session admin doit vivre sous `/admin/*`.**

```text
✅ /admin · /admin/content/... · /admin/preview/... · /admin/media/...
✅ /admin/api/...                       (endpoints internes du back-office)
❌ /api/kreiz/admin/... · /api/content/...   (si la route consomme la session)
✅ /api/contact · /api/analytics · ...  (endpoints publics, hors /admin,
                                         jamais dépendants de la session admin)
```

Formalisation dans le code :

- les patterns des routes admin sont déclarés en un seul endroit,
  `src/http/admin-routes.ts` (`ADMIN_ROUTE_PREFIX`, `ADMIN_HOME_PATH`,
  `ADMIN_LOGIN_PATH`, `ADMIN_LOGOUT_PATH`) — l'intégration, les pages et
  l'endpoint logout les consomment, aucune chaîne dupliquée ;
- le test garde **`tests/admin-routes.test.ts`** vérifie mécaniquement :
  (1) chaque route injectée par l'intégration est la spike publique ou vit
  sous le préfixe — un ajout futur hors `/admin` casse le test ; (2) le
  chemin du cookie est exactement le préfixe (`Path=/` ou tout autre
  élargissement casse le test).

> **Note aux slices futurs** : ne jamais contourner le `Path=/admin` en
> passant le cookie à `Path=/` pour « fixer » une route authentifiée
> placée ailleurs — c'est la route qui doit déménager sous `/admin/*`.
> Le helper `ADMIN_ROUTE_PREFIX` et la garde mécanique sont là pour ça ;
> toute exception doit être un changement explicite et documenté de cette
> règle, pas un contournement silencieux.

## Sliding et absolute expiration

- Création : `expires_at = now + 14 j`, `absolute_expires_at = now + 90 j`.
- Validation : révoqué → expirations (glissante et absolue) → admin existant
  → `disabled_at IS NULL` — un admin désactivé ne conserve aucun accès via
  une session existante.
- **Touch raisonnable** : `last_seen_at`/`expires_at` ne sont réécrits que si
  la dernière activité date de **plus d'1 heure**
  (`SESSION_TOUCH_THRESHOLD_MS`) — pas d'écriture DB par requête, seuil
  documenté. Prolongation : `expires_at = min(now + 14 j, limite absolue)`.
- `purgeExpired(before)` existe pour la maintenance future ; aucune
  planification automatique en V1.

## Repositories ajoutés / étendus

- `createAdminSessionsRepository` — create, findByTokenHash, findById,
  touch, revoke (idempotent), revokeAllForAdmin, purgeExpired. Pas de CRUD
  générique.
- `createAdminAuditLogRepository` — **append uniquement**. Aucun
  update/delete n'existe (garde testée : la surface du repository est
  exactement `['append']`).
- `createRateLimitsRepository` — `incrementWindowed` (upsert **atomique
  concurrent-safe** : la réinitialisation de fenêtre se fait dans la même
  instruction que l'incrément), get, reset, purgeExpired.
- `createAdminUsersRepository` étendu — updatePasswordHash, disable.
  Aucune suppression physique d'admin (FK RESTRICT de l'audit).

## Service auth et guards

`createAdminAuthService({ adminUsers, sessions, audit, rateLimits, secret? })`
expose login / resolveSession / logout / createAdmin / resetPassword /
disableAdmin. Décisions notables :

- **Anti-énumération** : email inconnu, mot de passe erroné, compte
  désactivé et formulaire malformé produisent le même `invalid-credentials`
  ; un email inconnu subit une vérification Argon2id « appeau » (mise en
  cache par processus) pour égaliser la latence.
- **Rate limiting « incrément d'abord »** : chaque tentative incrémente
  atomiquement les compteurs (email normalisé + IP HMACée) et le compteur
  post-incrément décide — la 6e tentative d'une fenêtre est refusée **sans
  vérification Argon2**. Pas de course read-then-write sous concurrence
  serverless ; les succès réinitialisent les compteurs (seuls les échecs
  consomment le budget « 5 échecs / 15 min »). Les échecs purgent aussi de
  façon opportuniste les fenêtres > 24 h.
- **Guards purs** (`resolveAdminAccess`) : distinguent `no-session`,
  `invalid`, `expired`, `revoked`, `admin-disabled` ; la route décide de la
  réponse (redirect 302 pour le web, `adminApiDenyStatus()` → 401/403 JSON
  pour les endpoints). Testables sans HTTP réel.

## CSRF

- Token **lié à la session** : `HMAC-SHA256(clé = token de session brut,
  label 'kreiz:csrf:v1')`. Imprévisible sans le cookie HttpOnly, renouvelé
  à chaque session, vérifié à temps constant (`csrfTokensMatch`) — sans
  stockage additionnel, donc **sans migration de schéma** (les tables du
  slice 1 n'ont pas de colonne CSRF ; en dériver évite une migration
  artificielle).
- Rendu dans les formulaires admin en champ hidden (`csrf_token`) ; toute
  mutation admin future réutilise `verifySessionCsrfToken()`.
- Appliqué dès ce slice au logout (403 sans token ou token invalide,
  vérifié **avant** toute action). Les GET restent sans effet de bord.
- **Compléments** (jamais en remplacement du token) : `Sec-Fetch-Site`
  (refus si présent et ≠ `same-origin`), Origin (hôte comparé à la requête)
  et le `checkOrigin` **natif d'Astro 7** (actif par défaut, 403 les POST
  de formulaires cross-origin).

## Audit

- `admin.login`, `admin.logout` (événements obligatoires) et
  `admin.password_reset` (reset CLI — valeur réelle : tracer qui a invalidé
  quelles sessions). `entity_type`/`entity_id` référencent l'admin ;
  `metadata` minimal (`sessionId`, `revokedSessions`) — pas d'IP complète,
  pas de token. Les échecs de login ne sont pas persistés (le rate limiting
  gère l'anti-abus, mission §14).

### Sémantique de `actor_admin_id` — invariant d'honnêteté (revue slice 2)

> **`actor_admin_id` ne doit jamais prétendre identifier un acteur qui n'a
> pas réellement réalisé l'action.**

- **Action d'une session admin authentifiée** → `actor_admin_id` renseigné
  avec l'admin réel (`admin.login`, `admin.logout`).
- **Action opérateur/système sans session admin** (CLI `kreiz`) →
  `actor_admin_id` **NULL**, l'admin cible est désigné par `entity_id` et
  la source par `metadata.source` (`"cli"`).

Concrètement, le reset CLI produit :

```text
actor_admin_id = NULL
action         = admin.password_reset
entity_type    = admin_user
entity_id      = <id admin cible>
metadata       = {"source": "cli", "revokedSessions": N}
```

La première implémentation du slice 2 utilisait l'admin cible comme acteur
— **corrigée** : cela affirmait implicitement que l'admin avait lui-même
réalisé le reset. Le changement impose :

- définition Core : `actor_admin_id` nullable (`kreiz_admin_audit_log`) ;
- **migration possédée par `apps/demo`** (`drizzle/0001_far_runaways.sql`,
  une instruction `ALTER … DROP NOT NULL`) — le Core ne possède toujours
  aucune migration ;
- test de migration rejouant **le schéma slice 1 → migration slice 2 →
  schéma courant** sur PostgreSQL réel dans un schéma isolé
  (`tests/integration/audit-migration.test.ts` : NOT NULL avant, nullable
  après, FK 23503 et RESTRICT 23001 conservés, ligne à acteur NULL
  enregistrable, l'admin ciblé reste supprimable, la ligne d'audit
  opérateur survit — append-only).

## CLI `kreiz`

- `kreiz admin:create` / `kreiz admin:reset-password` — interactif (email,
  nom, mot de passe masqué via mode raw + confirmation, 3 essais) ou flags
  (`--email`, `--name`, `--password`, `--password-stdin` pour les scripts).
- Accès base explicite : `KREIZ_DATABASE_URL` validé par
  `parseKreizDatabaseEnv()` — aucun accès en dur, aucun credential
  bootstrap. Le service CLI est câblé sans secret : il n'effectue jamais de
  login (`login()` lève explicitement sans `KREIZ_SECRET`).
- Logique de commande séparée de l'I/O terminal (`commands.ts` vs
  `kreiz.ts`/`prompts.ts`) → testable sans TTY. Le reset révoque **toutes**
  les sessions de l'admin et refuse proprement un email inconnu.

## Routes injectées et shell admin

- `/admin/login` (page SSR, GET + POST) — formulaire sans JavaScript,
  validation serveur, erreurs génériques, email préservé, mot de passe
  jamais republié ; déjà authentifié → redirect `/admin`.
- `/admin` (page SSR) — guard → redirect `/admin/login` si non
  authentifié (cookie résiduel nettoyé) ; shell sobre : layout, navigation
  (Dashboard actif ; Contenu/Commercial/Analyse affichés « Bientôt »,
  `aria-disabled`, pas de fausses pages), identité de l'admin, formulaire
  logout CSRF, zone de contenu avec état placeholder explicite.
- `/admin/logout` (endpoint POST) — session exigée, CSRF vérifié, révocation
  DB, audit, cookie invalidé, 303 vers `/admin/login` ; GET sans effet de
  bord (303 vers `/admin`).
- Le CSS du shell est **autonome** (`admin.css` importé par les pages) : ni
  Tailwind ni configuration CSS du projet consommateur ne sont requis —
  frontière Core/Project préservée.
- Responsive vérifié en réel (Chromium) à **1440 / 1024 / 768 / 390** :
  zéro overflow horizontal, navigation et logout utilisables à toutes les
  largeurs (l'email d'identité est masqué ≤ 768 px, choix de densité).

## Configuration Project → Core

**Aucune section ajoutée à `virtual:kreiz/config`** — tout ce dont le
slice 2 a besoin est soit une politique fixe (durées 14 j/90 j, cookie,
limites de rate limiting : non configurable par principe, mission §22),
soit de l'environnement runtime (`KREIZ_DATABASE_URL`, `KREIZ_SECRET`). La
route spike est **conservée** : les routes admin prouvent injectRoute,
SSR, build Vercel et frontière `exports`, mais pas encore la consommation
du module virtuel par une vraie route (contenus, slice 3) — suppression
différée, explicitement documentée.

## Environnement runtime

| Variable | Rôle |
|---|---|
| `KREIZ_DATABASE_URL` | URL PostgreSQL (Neon) des routes admin SSR et du CLI |
| `KREIZ_SECRET` | Secret de déploiement **≥ 32 caractères** (`openssl rand -base64 32`) — clé HMAC de pseudonymisation des IP (rate limiting). Requis pour le login ; jamais journalisé, jamais rendu au navigateur ; les messages d'erreur de validation n'en contiennent aucune trace |

Le mode dev de `apps/demo` charge `.env` (`node --env-file-if-exists=.env
./node_modules/astro/bin/astro.mjs dev`) — même mécanisme que `db:migrate`.

## CSP et en-têtes de sécurité

- **CSP applicative = capacité native d'Astro** (`security.csp`, stable
  depuis Astro 6) activée par la démo dans `astro.config.ts` : hashes
  calculés par Astro pour scripts/styles émis + directives explicites
  (`default-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `form-action 'self'`, `img-src 'self' data:`). Pas d'`unsafe-eval`, pas
  d'infrastructure maison de hashes/nonces. Les pages admin du slice 2
  n'ont aucun script client — elles sont CSP-compatible par construction.
- **Complément Core** sur chaque réponse `/admin` (les navigateurs
  ignorent ces directives dans un `<meta>`) :
  `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options:
  DENY` (anti-clickjacking, n'intersecte rien d'autre), `X-Robots-Tag:
  noindex, nofollow` (+ `<meta>` dans les pages), `X-Content-Type-Options:
  nosniff`, `Permissions-Policy`, et HSTS en production uniquement.
- `/admin` n'existe ni au build public ni dans un sitemap (aucun sitemap à
  ce stade — slice 9) ; le noindex est un en-tête HTTP + meta fiables.

## Décisions et découvertes d'implémentation

1. **`Referrer-Policy: strict-origin-when-cross-origin` et non
   `no-referrer`** — découvert et prouvé en test : Chromium **annule
   l'header `Origin` des POST de formulaires** quand la politique referrer
   est `no-referrer`, ce qui casse la validation Origin (checkOrigin natif
   Astro) avec un 403 systématique sur le login. La politique par défaut
   moderne préserve l'Origin same-origin sans fuir les URL complètes
   cross-origin. (Déviation assumée au cadrage §16 qui listait les
   en-têtes sans fixer leur valeur ; motivée par preuve.)
2. **CSRF dérivé plutôt que stocké** : pas de colonne `csrf_token_hash` en
   base, donc pas de migration. Le token est une fonction cryptographique
   de la session — même garanties (imprévisibilité, liaison, rotation),
   moins d'état.
3. **Rate limiting incrément-d'abord** (au lieu de vérifier-puis-
   incrémenter) : rend le compteur exact sous rafale concurrente, au prix
   d'une réinitialisation des compteurs après succès. Exactement la
   sémantique « 5 échecs / 15 min ».
4. **`@node-rs/argon2` déclaré dans `apps/demo`** : le traceur de
   dépendances du build Vercel résout les imports depuis les `node_modules`
   de l'app ; sous layout pnpm strict, un paquet natif dépendu du seul Core
   n'est pas tracé (constaté au build local, corrigé et vérifié). Même
   pattern documenté que `drizzle-orm` au slice 1.
5. **`vite.ssr.external: ['@node-rs/argon2']` injecté par l'intégration**
   : le bundler ne peut pas charger un binaire `.node` comme module JS.
   Le Core connaît sa dépendance native — le consommateur n'a rien à
   configurer.
6. **Astro 7 impose un serveur dev unique** (registre `astro dev`) — les
   E2E démarrent leur serveur avec `--ignore-lock` pour coexister avec un
   serveur de dev utilisateur sans le toucher.
7. **Script dev de la démo passe par `--env-file-if-exists`** : le runtime
   lit `process.env` (canal correct en serverless, où les variables de
   build ≠ runtime) ; `.env` alimente ce canal localement.
8. Le **CSS admin est autonome** (pas de classes Tailwind dans les
   composants Core) : évite toute dépendance à la configuration CSS du
   projet consommateur.
9. `disableAdmin` (service) désactive **et** révoque les sessions actives
   (cadrage §7) ; le guard gère aussi le cas « désactivé sans révocation »
   (statut `admin-disabled`) — vérifié par test avec `disabled_at` écrit en
   SQL direct.
10. **Invariant de revue — namespace `/admin/*`** : le cookie `Path=/admin`
    est conservé (jamais `Path=/`) et impose que toute route authentifiée
    vive sous le préfixe ; formalisé par `http/admin-routes.ts` (constantes
    uniques) et le test garde `tests/admin-routes.test.ts` (toute future
    route injectée hors `/admin` casse la CI, tout élargissement du Path
    aussi).
11. **Invariant de revue — honnêteté de l'acteur d'audit** :
    `actor_admin_id` nullable ; le reset CLI est une action opérateur
    (`actor NULL` + `metadata.source: 'cli'`), les événements de session
    gardent leur vrai acteur. Migration `0001` possédée par `apps/demo`
    (voir section Audit).

## Tests

- **Unitaires** (`packages/core/tests/`) : politique mot de passe et
  normalisation email ; tokens (entropie 256 bits, hash, CSRF dérivé et
  comparaison à temps constant, HMAC d'IP) ; Argon2id roundtrip + appeau ;
  fenêtres/expirations/touch (purs) ; guards purs (5 états, statuts API) ;
  en-têtes sécurité ; options cookie ; CSRF ; same-origin/Fetch Metadata ;
  orchestration de la soumission login (messages, statuts, email préservé,
  IP plateforme) ; validation de l'environnement runtime (sans fuite de
  valeurs) ; commandes CLI sans TTY (création, unicité, politique,
  interactif scripté, reset + révocation + audit).
- **Intégration Neon** (`packages/core/tests/integration/`) :
  `admin-auth.test.ts` — création admin (hash argon2id vérifié), unicité
  email (service + 23505 réelle), login réussi (session hash-only, audit,
  pas de token en base), échecs génériques, **5 échecs puis blocage même à
  bon mot de passe**, **12 incréments concurrents atomiques** (compteurs
  1..12 distincts), reset de fenêtre expirée dans la même instruction,
  resolveSession (touch réel, expirations glissante/absolue, révoqué,
  invalid, token inconnu), revokeAll, admin désactivé (SQL direct →
  `admin-disabled` ; service → révocation), reset password (ancien
  invalide, nouveau valide, sessions révoquées, **audit à acteur NULL +
  `source: 'cli'`**), audit append-only (surface `['append']`), purge,
  profil CLI sans secret (login lève).
  `audit-migration.test.ts` — **migration depuis le schéma slice 1** :
  chaîne rejouée dans un schéma isolé de la base réelle (0000 → NOT NULL,
  0001 → nullable, FK 23503 et RESTRICT 23001 conservés, action opérateur
  à acteur NULL enregistrable, admin ciblé supprimable, ligne d'audit
  opérateur survivante).
- **E2E Playwright** (`apps/demo/e2e/`) : anonyme → redirect login → login
  valide → shell (cookie `HttpOnly/Lax/Path=/admin`, 43 caractères) ;
  `/admin/login` déjà authentifié → `/admin` ; identifiants invalides
  (message générique, email préservé, aucune session) ; admin désactivé
  (login refusé + session existante invalidée) ; logout (POST + CSRF,
  **révocation prouvée en base**, cookie invalidé, re-accès refusé) ;
  mutation sans CSRF / CSRF falsifié → **403**, session intacte ; session
  révoquée en base → refus ; session expirée → refus ; preuve que la base
  stocke le **hash** du token et jamais la valeur du cookie. Les comptes
  sont créés par le **CLI réel** (`admin:create`), nettoyage complet
  (audit → admins → compteurs) : **0 ligne résiduelle vérifiée**.

## Validations exécutées

- `pnpm lint` ✅ · `pnpm typecheck` ✅ (tsc core + astro check, 0 erreur) ·
  `pnpm test` ✅ (**90 tests unitaires**) · `pnpm test:integration` ✅
  (**47/47** sur la branche Neon de développement, dont 3 tests de
  migration slice 1 → slice 2) · `pnpm build` ✅ (core tsc + copy, demo
  astro build + adapter Vercel) · E2E ✅ (**9/9**, Chromium contre serveur
  dev SSR + Neon).
- **Build Vercel** : sortie `.vercel/output/` vérifiée — page publique
  prérendue (`static/index.html` avec meta CSP), fonction SSR unique
  contenant les chunks login/index/logout, **binaire Argon2 `.node` tracé**
  dans la fonction, aucun appel DB au build (routes admin `prerender:
  false`, page publique sans DB).
- **Données résiduelles : 0** (les quatre tables auth comptées à 0 après
  intégration + E2E). Aucune migration générée (les tables existaient au
  slice 1) ; `packages/core` ne possède toujours aucun dossier de
  migration (garde testée).
- Responsive vérifié aux 4 largeurs (overflow 0 px partout).

## Compatibilité forks / CI

Le job `quality` reste sans secrets. Le job `integration` ajoute, **après**
les tests d'intégration : génération d'un `KREIZ_SECRET` éphémère,
installation Chromium Playwright, E2E contre la branche Neon éphémère —
toujours gated par `RUN_INTEGRATION` + présence des secrets, cleanup
`if: always()` inchangé. Une PR de fork se termine en succès avec notice
(comportement du slice 1 conservé).

## Écarts au cadrage

- `Referrer-Policy: strict-origin-when-cross-origin` au lieu de
  `no-referrer` (décision 1 — preuve en main).
- Un bin CLI consommable nécessite `@node-rs/argon2` dans l'app
  (décision 4) — coûte une ligne de `package.json` au consommateur,
  documentée.
- La route spike `/api/kreiz/spike` reste en place (consommation du module
  virtuel pas encore prouvée par une vraie route — slice 3).
