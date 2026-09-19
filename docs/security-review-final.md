# Revue sécurité finale — Kreiz Core V1

> Slice 11 — final security / adversarial review of the complete Core V1.
> Baseline Git : `b059735` (parent `01e6798`), branche `main`, arbre propre,
> stash vide. Cette revue n'est pas une slice fonctionnelle : elle cherche
> activement où le Core n'est **pas** sûr, corrige ce qui est raisonnablement
> local, et documente le reste.

## 1. Scope

- Périmètre : l'intégralité du monorepo — `packages/core` (domaine, services,
  data, HTTP, admin, adapters, CLI, intégration Astro, module virtuel),
  `apps/demo` (Project de référence : config, templates, pages, E2E),
  `apps/demo/drizzle` (chaîne de migrations 0000 → 0007), supply-chain
  (`pnpm-lock.yaml`, scripts de build), build de production (sortie Vercel).
- Modèle de menace (cahier des charges slice 11) : back-office exposé sur
  Internet, PostgreSQL (comptes admin, contenus, contacts), stockage objet,
  endpoints publics, formulaires visiteurs, analytics, médias, secrets de
  production, builds automatisés.
- Ordre de confiance appliqué : code réel > tests réels > schéma/migrations
  réels > build réel > documentation (les docs servent d'index, jamais de
  preuve).

## 2. Méthodologie

Six passes :

1. **Cartographie** de la surface d'attaque (routes, cookies, tokens, secrets,
   uploads, URLs sortantes, env) — aucune modification pendant la passe.
2. **Revue statique hostile par domaine** — cinq revues indépendantes (XSS et
   sinks HTML ; formulaires/mail/PII ; analytics ; couche data ; cycle
   contenu/médias) croisées avec une lecture directe de la couche
   HTTP/auth/CSRF, de l'implémentation SigV4, du renderer rich text, du CLI,
   du module virtuel et des en-têtes de sécurité.
3. **Sondes adversariales** exécutées : récursion Zod sur rich text hostile,
   cast UUID invalide (22P02), scénario complet de collision d'URL publique,
   build de production avec secret factice (preuve d'inlining), inspection de
   la CSP réellement servie (fonction Vercel invoquée directement), scan
   secrets/bundles de la sortie de build, `pnpm audit`.
4. **Chaînes transversales** : IP forgée → bypass rate-limit → croissance
   non bornée ; entrée publique → DB → UI admin (XSS vérifié négatif) ;
   upload → rich text → publish → build → public (cassé par CSP en prod,
   corrigé) ; contact → mail → audit → admin (pas d'open relay) ; slug →
   redirect → SEO → sitemap (sûr) ; session → CSRF → rebuild hook (gardé).
5. **Build / déploiement / supply-chain** : CSP effective, headers, split
   statique/fonctions, dépendances verrouillées, scripts de build.
6. **Contre-revue** des correctifs apportés (chemins d'erreur, doubles de
   test conformés à la nouvelle sémantique, tests d'invariants rendus
   indépendants de l'ordre d'arrivée du transport).

Outilillage local : PostgreSQL 18 réel + pont HTTP implémentant le protocole
SQL-over-HTTP de Neon (`@neondatabase/serverless` non modifié côté tests
d'intégration) — voir §10 limites.

## 3. Surface d'attaque auditée

- **Routes admin** (24 patterns, toutes sous `/admin`, `prerender: false`) :
  login, dashboard, logout, contenu (index/listing/new/edit/delete/publish/
  unpublish), preview `[id]`, rebuild, médias (page, upload-request, confirm,
  status, alt, retry, delete), formulaires (liste, détail, status, notify),
  analytics.
- **Routes publiques** : `POST /api/forms/[key]`, `POST /api/analytics/event`,
  `/api/analytics/beacon.js` (prérendu), `/sitemap.xml`, `/robots.txt`
  (prérendus).
- **Cookie** : `kreiz_admin_session`, HttpOnly, SameSite=Lax, Secure en prod,
  `Path=/admin` — jamais envoyé au site public (garde mécanique
  `tests/admin-routes.test.ts`).
- **Secrets** : `KREIZ_DATABASE_URL`, `KREIZ_SECRET`, deploy hook URL, bloc
  storage (access/secret key), bloc mail (webhook URL + token).
- **Mutations** : 13 POST admin (session + CSRF lié à la session +
  same-site/Origin sur toutes — vérifié fichier par fichier, y compris les
  endpoints JSON via `authenticateMediaApi`), 1 POST public formulaires
  (token HMAC + honeypot + rate limit + idempotence).
- **URLs sortantes** : deploy hook Vercel (env, HTTPS forcé en prod), relais
  mail (env, HTTPS forcé, `redirect: manual`), endpoint storage (env).
- **Build** : lectures DB au build (sitemap, redirects, `getStaticPaths`),
  module virtuel `virtual:kreiz/config`, intégration Astro (injection de
  routes), chaîne drizzle 0000 → 0007.

## 4. Findings

Aucun CRITICAL. Sévérité = impact × exploitabilité réelle. Chaque finding
correctif est verrouillé par un test de régression.

### HIGH — 2 (corrigés)

**SRV-01 — Snapshot d'environnement du build incrusté dans le bundle serveur
(secrets exposés dans l'artefact).**
Composant : `http/server-env.ts` (`getKreizAdminRuntime`).
Preuve : build de production avec `KREIZ_SECRET=PROBE…` → la chaîne littérale
apparaissait dans `.vercel/output/_functions/chunks/server-env_*.mjs`, dans
un `Object.assign({défauts}, {KREIZ_DATABASE_URL, KREIZ_SECRET, …})` —
l'esbuild lowering de `import.meta.env` (forme `?.` opaque, puis
intermittemment même en accès direct) figeait les variables présentes au
build. Sur Vercel, les variables de build incluent les secrets du projet :
`KREIZ_SECRET` et l'URL de base partaient dans le fichier déployé.
Impact : copie des secrets au-delà de leur frontière d'exécution (artefact,
caches CI, sources maps éventuelles) — violation de l'invariant documenté
« jamais dans les logs ni le HTML » étendu aux bundles.
Pourquoi les protections échouaient : aucun test ne regardait le bundle
servi ; l'E2E tourne en dev (pas de bundling).
Correction : lecture d'exécution `process.env.NODE_ENV === 'production'`
(jamais inlinée). Vérification empirique post-fix : secret absent du build,
pattern `ASSETS_PREFIX` (signature du snapshot) disparu de tous les chunks.

**SRV-02 — L'espace d'URL public n'était pas unique : deux contenus publiés
pouvaient vivre sur le même chemin.**
Composant : schéma + `services/publication.ts`.
Preuve (scénario éditorial pur, reproductible) : publier A sur `x` → renommer
le brouillon de A en `z` (Save ≠ Publish : le snapshot public de A reste
`x`) → créer B avec le slug `x` (aucune collision : l'index unique ne couvre
que les slugs éditoriaux courants) → publier B. Deux snapshots publiés
revendiquent `/ns/x` : `getStaticPaths` reçoit des params dupliqués, le
lecteur public `limit 1` rend un gagnant arbitraire, les redirections
peuvent être masquées. Confirmé indépendamment par deux passes de revue.
Correction : migration **0006** (index unique partiel
`(route_namespace, published_slug) WHERE status='published' AND deleted_at
IS NULL`), pré-contrôle de publication (`publishedPathOccupiedByOther`) et
traduction de la violation 23505 en `PublishedPathOccupiedError` (refus
métier, bannière admin `conflict`). Tests d'intégration : scénario complet
refusé, état intact, un seul chemin public vivant. Note opérateur : sur une
base existante contenant déjà des doublons, `CREATE UNIQUE INDEX` échoue
bruyamment (désiré) — résoudre avant de migrer.

### MEDIUM — 11

**SRV-03 — Identité de rate limiting contrôlée par le client hors Vercel.**
`clientIpFromHeaders` fait confiance à `x-real-ip` puis
`x-vercel-forwarded-for` puis `x-forwarded-for` (première entrée). Sur Vercel
ces en-têtes sont posés par la plateforme (non falsifiables) : sûr. Hors
Vercel (Node direct, nginx en mode append, CDN ne posant pas ces en-têtes) :
un script forgeant `X-Real-Ip` obtient une fenêtre de rate limit fraîche à
chaque requête — bypass complet des limites login/forms/analytics **et**
croissance non bornée de `kreiz_rate_limits` (une ligne par IP forgée).
Corrections partielles livrées : bucketisation IPv6 /64 (voir SRV-14),
purges bornées par lot (SRV-11), purge des compteurs par la rétention
analytics. Résiduel : le modèle de confiance des en-têtes (configuration
par topologie) reste à traiter en V2 — **condition documentée : ne pas
déployer hors Vercel sans revoir cette confiance** (dette #10 affinée).

**SRV-04 — Corps de requête non borné sur l'endpoint formulaire public
(DoS mémoire hors Vercel).** `formData()` bufferisait tout le corps avant
les bornes applicatives (32 KiB). Sur Vercel la plateforme plafonne
(~4,5 Mo) ; ailleurs, un multipart géant OOM le processus. Corrigé : borne
de transport 1 MiB — `Content-Length` d'abord, lecture streaming plafonnée
ensuite (même discipline que l'endpoint analytics, désormais appliquée au
plus exposé des deux).

**SRV-05 — La CSP de référence cassait les médias en production.** Vérifié
sur la sortie de build réelle (fonction Vercel invoquée) : la CSP livrée
(header sur les pages SSR, meta sur les pages prérendues) était
`default-src 'self' … img-src 'self' data:` sans `connect-src`. Conséquences
en prod : PUT présigné vers le storage **bloqué** (admin), images CDN des
pages publiques **bloquées**. Jamais vu en E2E (dev = pas de CSP). Fail
closed (pas de faille), mais la config de référence était invivable.
Corrigé : la CSP de la démo dérive `img-src`/`connect-src` des origines
storage de l'environnement ; exigence documentée pour les Projects
(operations.md).

**SRV-06 — sharp 0.34.5 portait deux avis HIGH (libvips CVE-2026-33327/33328/
35590/35591 ; libheif GHSA-g89c-p67h-r497, GHSA-2jg2-4ch7-h545).** Surface
atteignable : décodage d'images arbitraires **admin-uploadées, AVIF inclus**
(accepté par la politique média). Corrigé : bump `sharp ≥ 0.35.4` (core +
demo + lockfile) ; `pnpm audit --prod` : aucune vulnérabilité connue.

**SRV-07 — Le mailer webhook suivait les redirections.** Un relais
compromis/mal configuré répondant 3xx pouvait rediriger le corps POST (PII
visiteur : nom, email, message) vers un autre hôte, y compris en HTTP clair
(downgrade https→http), le header `Authorization: Bearer` suivant selon le
runtime. Corrigé : `redirect: 'manual'` — un 3xx devient un refus propre
(`rejected` + statut). Test : 302 → exactement une requête, échec mappé.

**SRV-08 — Envoi double de notification possible (ré-armage pendant un envoi
en vol).** `rearmNotification` remettait le compteur à zéro sans savoir si
une tentative était en vol (statut inchangé pendant l'envoi) : double-clic
admin pendant un webhook lent (timeout 10 s) → deux emails ; le futur cron
de rattrapage aurait systématisé la double expédition. Corrigé : **bail de
claim** — colonne `notification_claimed_at` (migration **0007**) posée par
chaque claim, libérée à la résolution (sent/failed) ; claim et ré-armage
refusent tant que le bail court ; la file du balayage exclut les envois en
vol. La relance admin passe toujours outre le **backoff** (décision
explicite), jamais outre un envoi en vol. Tests : double-clic bloqué,
expiration du bail, ré-armage post-échec immédiat.

**SRV-09 — Images plus étroites que la plus petite variante : prêtes mais
invisibles.** Aucun spec ≤ largeur source → zéro variante → média `ready`
publiable, puis figure/couverture **silencieusement absentes** du site
(l'original privé n'est jamais servi). Corrigé : variante de repli à la
largeur naturelle (ré-encodée, métadonnées nettoyées, sans upscale).
Test Sharp réel.

**SRV-10 — L'attribution analytics joignait le slug éditorial, pas le slug
publié.** Une page vue à l'URL vivante d'un contenu publié (slug éditorial
depuis renommé) ne s'attribuait pas ; une vue sur un slug non publié
s'attribuait à tort. Corrigé : jointure sur `published_slug` (l'espace
d'URL public réel).

**SRV-11 — Purges non bornées (`DELETE … RETURNING` sur chemins atteignables).**
La purge de rétention analytics (déclenchée par une visite du dashboard)
matérialisait chaque id supprimé en mémoire Node — catastrophique sur une
table gonflée par un flot hostile ; la purge des rate limits courait sur
chaque login en échec (endpoint non authentifié). Corrigé : purges par lots
bornés (5 000/lot, sans RETURNING), et la rétention purge aussi les
compteurs échus.

**SRV-12 — Rebuild manuel non plafonné (tempête de deploy hooks).** Chaque
clic sur `/admin/rebuild` enclenchait un build provider ; un clic répété (ou
un script rejouant une session valide) draine le budget de builds et bloque
les déploiements réels. Corrigé : plafond global d'un rebuild manuel par
minute (clé `kreiz:rebuild-manual:v1`, fenêtre glissante en base), bannière
`cooldown` ; les rebuilds des publications ne sont pas plafonnés (un par
publication est le contrat).

**SRV-13 — Récursion Zod sur rich text hostile : `RangeError` brut.** Un
document imbriqué à ~1000 niveaux (34 Ko, sous la borne de 256 KiB) faisait
déborder la pile du parseur Zod **avant** le garde de profondeur (30) :
500 auto-infligé côté admin, crash de build sur données corrompites.
Corrigé : pré-scan de profondeur **itératif** (pile explicite, borne
structurelle 400 ≫ 70 niveaux légitimes) avant l'entrée dans le schéma —
erreur de domaine `depth-exceeded` propre. (Classé MEDIUM-LOW : déclencheur
admin/DB uniquement, impact requête unique.)

**SRV-MIG — Migration 0005 : swap de vocabulaire CHECK sans migration de
données.** Une base ayant collecté des événements `contact_form_submitted`
(ou des valeurs hors bornes) entre slices échouerait au `ADD CONSTRAINT` au
rejeu. Probabilité faible (chaîne démo vide par construction), risque réel
documenté ; migrations historiques non modifiées (règle de la revue).

### LOW — 9 (corrigés sauf mention)

- **SRV-14 — Rotation IPv6** : 2^64 identités par hôte rendaient le budget
  par IP décoratif. Corrigé : bucketisation /64 à l'extraction (expansion
  correcte des formes abrégées, IPv4 inchangé — CGNAT respecté). Tests
  unitaires.
- **SRV-15 — UUID invalide → 500** sur trois routes admin formulaires
  (`[id]` non UUID → 22P02 brut). Corrigé : garde de format dans le
  repository contact (même discipline que contenus/médias) → 404 propre.
- **SRV-16 — NUL/substituts isolés → 500** sur soumission de formulaire
  (jsonb 22021). Corrigé : rejet en validation de schéma (message de champ),
  CRLF toujours autorisé.
- **SRV-17 — Helper `contactStandalonePage`** interpolait le titre sans
  échappement (appelants sûrs aujourd'hui, contrat fragile demain).
  Corrigé : échappement interne.
- **SRV-18 — Namespaces de route réservés** (`admin`, `api`) acceptés en
  déclaration : pages publiques sous les chemins du cookie de session.
  Corrigé : fail-fast à la déclaration.
- **SRV-19 — Suffixes de slug au-delà de la borne 120.** Corrigé : troncature
  de la base avant suffixage.
- **SRV-20 — `renderRichTextDocument` faisait confiance au `level`** (API
  publique, document non reparsé → injection de nom de balise possible par
  intégrateur négligent). Corrigé : garde 2–3, aucun rendu sinon.
- **SRV-21 — Lecture storage non plafonnée** (l'URL présignée ne lie pas le
  corps : ré-PUT plus gros possible entre `head` et `read`). Corrigé :
  `read(key, { maxBytes })` en streaming (Content-Length **et** flux),
  échec traduit en rejet propre au confirm, en `failed` au processing.
- **SRV-22 — `payload-too-large` court-circuite le rate limit** (422 non
  plafonnés post-parse) : constaté, non corrigé (impact mineur, coût de
  fix non nul) — documenté.
- **`analyticsCtaAttributes`** renvoyait l'id brut tronqué quand la
  normalisation échouait. Corrigé : aucun attribut.

### Faux positifs éliminés (vérifiés, non retenus)

- « XSS stocké admin via payload contact/analytics » — tous les sinks sont
  des expressions Astro auto-échappées ; aucun `set:html` hors renderers
  déterministes (inventaire exhaustif des 19 occurrences).
- « Échappement JSON-LD » — sérialisation avec échappement de `<` et
  U+2028/2029 : pas de sortie de contexte script possible.
- « SSRF via storage/relais/hook » — URLs d'environnement uniquement
  (catégorie A : configuration opérateur de confiance), jamais de saisie
  visiteur/admin.
- « Énumération admin par timing » — `dummyPasswordVerify` (fix 01e6798)
  vérifie réellement à chaque appel ; comportement générique homogène.
- « Open redirect via confirmationPath » — config validée
  `isInternalConfirmationPath`, aucune influence client.

## 5. Invariants re-vérifiés (extraits)

- **CSRF** : 13/13 mutations admin gardées (session + token dérivé HMAC du
  token de session + comparaison temps constant + same-site/Origin) ;
  endpoints JSON via en-tête `x-kreiz-csrf-token` — même vérification
  cryptographique.
- **Sessions** : 256 bits, SHA-256 en base, 14 j glissante / 90 j absolu,
  révocation au logout/reset, admin désactivé → 403, cookie durci
  `Path=/admin`.
- **Save ≠ Publish** : lecteur public/sitemap/SEO/redirects sur les
  snapshots `published_*` uniquement ; preview noindex sous session ;
  corruption = échec explicite, jamais de repli draft.
- **Médias** : clés serveur-générées sûres, présignation PUT mono-clé
  10 min content-type figé, vérification magic bytes au confirm, machine
  d'états arbitrée par UPDATE conditionnels, originaux privés/jamais servis.
- **SigV4 maison** : clés restreintes (pattern sûr, `..` refusé), canonicals
  triviaux, vecteurs officiels AWS en test, réel S3 local en E2E — aucune
  faille prouvée.
- **Open relay** : enveloppe From/To/Subject entièrement config/déclaration
  (validées sans caractères de contrôle), Reply-To re-validé au envoi ;
  corps JSON, aucun header injectable.
- **PII analytics** : pas d'IP, pas d'UA brut, pas de query string ;
  DNT/GPC honorés côté serveur ; vocabulaire d'événements fermé.

## 6. Dettes existantes réévaluées

Registre complet dans `technical-debt.md` (mis à jour). Points saillants :

1. **Rétention PII contact (#1)** — inchangée, **condition bloquante** pour
   un site recevant de vrais visiteurs (voir §7-A).
2. **Confiance X-Forwarded-For (#10)** — affinée : sûre sur Vercel
   (en-têtes plateforme), HIGH hors Vercel ; mitigations partielles livrées
   (bucketisation /64, purges bornées et régulières) ; le modèle de
   confiance par topologie reste V2. **Condition : Vercel-only tant que
   non traité.**
3. **Concurrence publication (#2/#3)** — inchangée ; impact opérationnel
   (redirection absente jusqu'à la prochaine publication), pas une frontière
   de sécurité (drafts invérifiables côté public, re-confirmé).
4. **Scheduler (#6/#15)** — partiellement adouci (la rétention purge
   désormais aussi les compteurs) ; sans cron externe : promesse de rétention
   non tenue hors visites du dashboard, notifications non rejouées, médias
   `processing` collés irrécupérables sans SQL manuel.
5. **Migration 0005 (#4)** — nouvelle note : le rejeu sur des données
   intermédiaires échoue (voir SRV-MIG).
6. Les autres (couplage Drizzle, scan JSONB, assets admin CDN, médias
   abandonnés `uploading`, audit disableAdmin) — inchangées, sévérités
   confirmées.

## 7. Points production (questions A–E du cahier des charges)

**A. Rétention des demandes de contact.** Non acceptable en l'état pour un
site à vrai trafic : `kreiz_contact_requests` conserve nom/email/message
sans limite, `handled` ne supprime rien. Correction minimale réelle : une
politique Project (durée fixée, purge planifiée par cron — un `DELETE …
WHERE created_at < now() - interval` suffit ; les listes admin restent
bornées). Le Core n'expose pas encore de primitive de purge V1 — à ajouter
en V1.x si un Project en a besoin, sinon documenter la responsabilité
(privacy-data-map à jour).

**B. X-Forwarded-For.** Vercel : sécurisé — les trois en-têtes lus sont
posés/écrasés par la plateforme. Hors Vercel : identité client-contrôlable
(SRV-03). Ne pas modifier le Core maintenant : la bonne correction est une
configuration de confiance par topologie (V2), une inversion de priorité
des en-têtes aujourd'hui casserait le chemin Vercel validé.

**C. Scheduler externe.** Sans cron : rétention analytics non exécutée
(promesse vie privée), relances de notification jamais rejouées (la relance
admin manuelle existe), compteurs purgés seulement aux visites dashboard,
médias collés sans voie opérateur. Un cron Project appelant
`runRetention` + `runNotificationRecovery` + `processStuckMedia` (fonctions
existantes et testées) est la condition — les endpoints cron restent à
exposer en V2 (la revue n'en a pas ajouté : surface minimale).

**D. Publication non atomique.** Impact de cohérence opérationnelle
uniquement — jamais un couloir de fuite de drafts (snapshots seuls lus,
re-vérifié). Pire cas : redirection non matérialisée jusqu'à la republication.

**E. Média DB/storage.** On ne peut obtenir **que** des orphelins storage
(ligne supprimée, objets restants) : la suppression est refusée tant que
référencée (FK RESTRICT sur les couvertures + comptage JSONB riche) — jamais
une ligne sans objets servis. Balayage d'orphelins : confort V2.

## 8. Corrections appliquées (résumé)

| # | Sévérité | Correction | Fichiers clés |
|---|----------|------------|---------------|
| SRV-01 | HIGH | `process.env.NODE_ENV` à l'exécution | `http/server-env.ts` |
| SRV-02 | HIGH | Index unique 0006 + pré-contrôle + 23505 | `tables/content-entries.ts`, `repositories/content-entries.ts`, `services/publication.ts`, `drizzle/0006` |
| SRV-03/14 | MEDIUM | /64 IPv6, purges bornées + régulières | `http/admin-login.ts`, `repositories/rate-limits.ts`, `services/analytics.ts` |
| SRV-04 | MEDIUM | Cap transport 1 MiB formulaire | `forms/public-submit.ts`, `domain/forms/policy.ts` |
| SRV-05 | MEDIUM | CSP dérivée de l'environnement | `apps/demo/astro.config.ts`, `docs/operations.md` |
| SRV-06 | MEDIUM | sharp ≥ 0.35.4 | `package.json` ×2, lockfile |
| SRV-07 | MEDIUM | `redirect: 'manual'` mailer | `adapters/mailer/webhook.ts` |
| SRV-08 | MEDIUM | Bail de claim (0007) | `tables/contact-requests.ts`, `repositories/contact-requests.ts`, `services/contact.ts`, `drizzle/0007` |
| SRV-09 | MEDIUM | Variante repli largeur naturelle | `adapters/image/sharp.ts` |
| SRV-10 | MEDIUM | Attribution sur `published_slug` | `repositories/analytics-events.ts` |
| SRV-11 | MEDIUM | Purges par lots | `repositories/analytics-events.ts`, `repositories/rate-limits.ts` |
| SRV-12 | MEDIUM | Cooldown rebuild manuel 1/min | `admin/routes/site-rebuild.ts`, `admin/pages/index.astro` |
| SRV-13/15–21 | LOW | Voir §4 | — |

Tests ajoutés/ajustés : collision d'URL publique (intégration), bail de
notification (intégration + double in-memory), UUID contact, redirection
mailer, cap lecture storage, variante étroite, profondeur rich text, garde
renderer, NUL/substituts, namespaces réservés, suffixes slug, CTA, IPv6 ;
deux tests de concurrence reformulés sur l'invariant (un seul gagnant)
plutôt que l'ordre d'arrivée du transport.

## 9. État production après revue

**Verdict : CONDITIONALLY READY.**

Le Core est prêt pour un déploiement de production **aux conditions
suivantes** (toutes documentées) :

1. **Rétention des demandes de contact** définie et planifiée par le Project
   (dette #1) avant d'exposer de vrais formulaires à de vrais visiteurs.
2. **Cron externe** pour rétention analytics / relances / récupération média
   (dette #6/#15) si la promesse de rétention et la résilience doivent être
   strictement tenues.
3. **Vercel uniquement** tant que la confiance des en-têtes IP n'est pas
   configurable (dette #10 / SRV-03 résiduel).
4. **CSP du Project dérivée de sa configuration storage** (le Core ne peut
   pas la deviner — la démontre le pattern désormais en place dans
   `apps/demo/astro.config.ts`).

Validations post-corrections, toutes vertes : `pnpm lint`, `pnpm typecheck`
(core + demo), `pnpm test` **736/736** (unitaires + intégration PostgreSQL
réel via pont Neon-HTTP), `pnpm build` + scans du bundle (secret absent,
plus de snapshot d'env, CSP conforme aux origines configurées),
`pnpm test:e2e` **84/84**, `pnpm audit --prod` sans vulnérabilité connue,
`drizzle-kit` chaîne 0000 → 0007 cohérente (journal + snapshots).

## 10. Limitations de la revue

- L'intégration et l'E2E ont couru sur PostgreSQL 18 local via un pont
  implémentant le protocole HTTP de Neon (driver réel). La sémantique
  SQL est celle de PostgreSQL réel ; la **topologie** réseau de Neon
  (région, concurrence HTTP réelle) n'est pas reproduite — l'ordre
  d'arrivée de requêtes concurrentes y est moins déterministe (deux tests
  ont été reformulés sur leur invariant pour cette raison).
- Aucun fuzzing étendu (Sharp, parsers) au-delà des bornes documentées ;
  aucune vérification du comportement réel de Vercel (en-têtes, limites) par
  déploiement effectif — affirmations fondées sur la documentation de la
  plateforme et la config de la démo.
- L'audit supply-chain couvre les avis connus de `pnpm audit` à date ;
  les dépendances de développement restent avec des avis bas (s3rver/
  fast-xml-parser — surface de test uniquement).
- Absence de preuve ≠ preuve d'absence : la revue a activement cherché à
  casser le Core ; ce qui reste est documenté, pas ignoré.

## 10 bis. Passe de fermeture pré-production (post-revue Claude)

Suite à la revue senior indépendante (Claude — aucune vulnérabilité
critique/high nouvelle, verdict CONFIRMÉ : architecture, code, sécurité
solides ; CONDITIONALLY READY), une dernière passe a fermé les écarts
concrets restants :

- **Endpoint de maintenance** `POST /api/maintenance` — déclencheur du cron
  externe (Vercel Cron) : authentification bearer `KREIZ_MAINTENANCE_TOKEN`
  (≥ 32 car., comparaison temps constant via SHA-256 + `timingSafeEqual`),
  refus par défaut 503 sans configuration, POST uniquement, compteurs
  techniques sans PII, idempotent. Câble les services existants sans
  dupliquer de logique : `runNotificationRecovery`, `runContactRetention`,
  `processStuckMedia`, `runRetention` (qui purge aussi les rate limits).
  `retryFailedMedia` reste volontairement une action admin (aucun budget de
  tentatives en V1 — un fichier invalide bouclerait).
- **Rétention PII contact (opt-in)** — `KREIZ_CONTACT_RETENTION_DAYS`
  (30–730 j, reco 180) : purge par lots bornés (5 000/lot, plafond 10 000/
  invocation) des demandes **traitées** (`handled`) anciennes ; les `new`
  ne sont jamais purgées automatiquement. Sans la variable : aucune purge
  (décision opérateur explicite).
- **Concurrence optimiste des Saves** — `expected_updated_at` (version
  `updated_at` rendue au formulaire) : UPDATE conditionnel ; 0 ligne ⇒
  `ContentConcurrentModificationError` (409, bandeau clair, aucun
  écrasement silencieux). **Publish volontairement non gardé, par
  construction** : il ne transporte aucune donnée de formulaire (il publie
  l'état courant en base au moment de la requête) — rien de périmé ne peut
  être publié, et Save ≠ Publish reste intact (test d'intégration dédié).
- **CI anti faux vert** — `KREIZ_REQUIRE_INTEGRATION_DB=1` (posé uniquement
  par le job `integration`) : sans base, les fichiers d'intégration
  échouent bruyamment au lieu de sauter ; local et job `quality` des forks
  restent en skip.
- **Guard préconditions Astro** — `kreiz()` refuse tôt et clairement une
  config sans adapter (les routes SSR injectées exigent un runtime), sans
  imposer d'adapter particulier.

## 11. État Git

Aucun commit, aucun push (volontaire — relecture humaine avant fermeture).
Toutes les corrections vivent dans l'arbre de travail : ~56 fichiers
modifiés/créés, deux migrations (0006, 0007), lockfile mis à jour.
