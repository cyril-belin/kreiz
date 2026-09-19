# Opérer un Project Kreiz

> Guide opérationnel (slice 10) : migrations, sauvegardes, recovery,
> rétention, cron externe, monitoring. Ce que le Core fait — et ce que
> l'hébergeur/le Project doit fournir.

## 1. Migrations

- La chaîne de migrations appartient à l'application
  (`apps/demo/drizzle/` pour la démo) — jamais au Core.
- Audit slice 10 : rejeu intégral `0000 → 0005` sur une base isolée,
  schéma obtenu **identique** à celui d'une base migrée par drizzle-kit
  (225 objets comparés : tables, colonnes, contraintes, index) ;
  `drizzle-kit check` ne rapporte aucune divergence schéma/migrations.
- Procédure de déploiement : `drizzle-kit generate` en local → les
  fichiers SQL versionnés dans le dépôt → `pnpm db:migrate` (driver HTTP
  Neon) contre la base de production avant/exécuté par le pipeline.
- Recommandation : une branche Neon par environnement ; tester les
  migrations sur une copie avant la production.

## 2. Sauvegardes attendues (fournies par l'hébergeur/le Project)

Le Core n'embarque pas de système de backup :

| Donnée | Moyen | Responsable |
|---|---|---|
| PostgreSQL | PITR / snapshots Neon | hébergeur DB |
| Objets médias (originaux + variantes) | versionnement du bucket / réplication R2-S3 | hébergeur storage |
| Site public | le dépôt Git + la base suffisent à reconstruire (build déterministe depuis les snapshots publiés) | — |

Point de restoration : la base est la source de vérité ; le site public se
reconstruit intégralement par un build.

## 3. Recovery / maintenance — table de référence

Le Core livre des fonctions de recovery **explicites**. Aucune n'est
branchée sur un scheduler interne : elles attendent un cron/worker externe
(Vercel Cron, GitHub Action schedulée, worker maison) ou une action admin.

| Fonction | Quand l'appeler | Idempotente | Fréquence conseillée | Conséquences |
|---|---|---|---|---|
| `createMediaRecoveryService().retryFailedMedia()` | des médias sont `failed` (fichier intrinsèquement invalide ou incident Sharp) | oui — chaque média `processing→failed` retraité une fois par appel ; un fichier invalide re-échoue et attend un humain | toutes les 6–12 h | repasse `failed → processing`, ré-enfile le job, audit `media.retried` (acteur NULL, source recovery) |
| `createMediaRecoveryService().processStuckMedia({ olderThanMs })` | jobs perdus : `processing` sans terminaison (crash, `waitUntil` coupé) | oui — pas de transition d'état, ré-enfile ; l'idempotence du traitement arbitre les courses | toutes les heures (défaut `olderThanMs` = 1 h) | ré-enfile le traitement, audit `media.retried` (reason stuck) |
| `createContactService().runNotificationRecovery()` | relais email momentanément indisponible ; transport ajouté après coup (promotions `not_configured`) | oui — claim conditionnel par tentative, backoff respecté | toutes les 15–30 min | promeut les `not_configured` puis envoie les notifications dues (max 5 tentatives, backoff 2 min/10 min/1 h/6 h), audit source recovery |
| `createAnalyticsService().runRetention()` | purge des événements au-delà de `retentionDays` | oui — `DELETE WHERE created_at < cutoff` | quotidienne (appelée aussi opportunistiquement par le dashboard admin) | supprime définitivement les événements analytics expirés |
| `rateLimits.purgeExpired()` | nettoyage des compteurs expirés | oui | appelé déjà opportunistement à chaque login ; un passage quotidien en cron est un plus | libère des lignes `kreiz_rate_limits` |

Actions admin équivalentes (UI) : relance de notification depuis la boîte
de contact, retry média depuis la médiathèque, rebuild manuel depuis le
dashboard. Le parcours « panne transport → relance admin → livré » est
prouvé par l'E2E global (`e2e/core-recovery.spec.ts`).

### 3.1 Endpoint de maintenance — `POST /api/maintenance` (livré en passe de fermeture)

Le Core livre désormais le déclencheur attendu par le cron externe : un
endpoint unique qui enchaîne les recoveries ci-dessus **sans dupliquer
aucune logique métier** (il appelle les services, rien de plus).

- **Authentification** : `Authorization: Bearer $KREIZ_MAINTENANCE_TOKEN`
  (≥ 32 caractères), comparaison temps constant. **Sans la variable, toute
  requête reçoit un 503 et rien ne s'exécute** — en production, l'absence
  du token empêche la maintenance. Faux token → 401 sans indice.
  `POST` uniquement (GET → 405) ; jamais de session admin navigateur.
  **Contrat HTTP** : le POST doit porter un `content-type`
  (ex. `application/json`) — le `checkOrigin` natif d'Astro refuse un POST
  « nu » sans en-tête `Origin` (403), et un cron n'en envoie pas : avec un
  content-type JSON, la requête atteint la garde bearer comme prévu.
- **Réponse** : compteurs techniques uniquement — `contactNotification`
  (promoted/sent/failed/skipped), `contactRetention` (purged ou
  `disabled:true` si `KREIZ_CONTACT_RETENTION_DAYS` est absente),
  `mediaStuck` (recovered ou `unavailable:true` sans stockage),
  `analyticsRetention` (deleted — purge aussi les compteurs rate limits
  échus). Aucune PII, aucun secret.
- **Idempotence** : totale (claims conditionnels, purges bornées) — deux
  appels rapprochés sont sûrs ; le second trouve rarement du travail.
- **Fréquences recommandées** (Vercel Cron, une seule entrée suffit) :
  **toutes les 30 minutes** couvre la contrainte la plus serrée (contact
  recovery) et reste conservative pour les autres. Granularité Vercel
  limitée (pas de cron horaire exact en plan gratuit) : un appel toutes les
  30 min ou toutes les heures est acceptable — compromis documenté : plus
  fréquent = notifications relancées plus tôt ; moins fréquent = retries
  média plus lents. `retryFailedMedia` n'est **pas** câblé dans l'endpoint :
  aucun budget de tentatives n'existe en V1, un fichier intrinsèquement
  invalide bouclerait indéfiniment — le retry reste une action admin
  explicite (médiathèque).
- **Vercel Cron** (dans `vercel.json` du Project) :
  `{ "crons": [{ "path": "/api/maintenance", "schedule": "*/30 * * * *" }] }`.
  Vercel Cron appelle en GET : utiliser un petit wrapper Project ou un
  déclencheur externe capable de POSTer avec l'en-tête Bearer (GitHub
  Action schedulée, cron système + curl, uptimerobot type service). Le
  endpoint reste en 405 sur GET par refus de principe — aucun effet de bord
  n'est accessible sans POST authentifié.
- **Rotation du token** : changer `KREIZ_MAINTENANCE_TOKEN` dans
  l'environnement et redéployer ; les appels en cours avec l'ancien token
  reçoivent 401 immédiatement (aucune session à invalider).

## 4. Médias / stockage

- Bucket S3-compatible ; originaux **privés**, variantes publiques
  immuables (`Cache-Control: immutable`) servies par
  `KREIZ_STORAGE_PUBLIC_BASE_URL` (CDN recommandé).
- CORS du bucket : PUT autorisé depuis le domaine admin (config de
  référence dans `docs/slices/slice-5.md`).
- **CSP du Project (revue sécurité finale)** : l'upload direct navigateur →
  stockage est un `fetch`/XHR cross-origin, et les variantes sont des
  `<img>` CDN — la CSP du Project **doit** porter `connect-src 'self'
  <origine du endpoint storage>` et `img-src … <origine du CDN public>`,
  dérivées de `KREIZ_STORAGE_ENDPOINT` / `KREIZ_STORAGE_PUBLIC_BASE_URL`.
  Pattern de référence : `apps/demo/astro.config.ts`. Sans cela, la
  production casse silencieusement les médias (l'E2E tourne en dev, où la
  CSP n'est pas appliquée).
- Suppression : refusée si le média est référencé (couverture courante ou
  snapshot publié) ; un média libre part avec ses objets. La suppression
  DB/stockage n'est pas atomique (voir
  [technical-debt.md](technical-debt.md)) — le recovery par retry reste
  possible.

## 5. Mail

- Relais webhook (`KREIZ_MAIL_*`) : le Core POST le message préparé ;
  l'infrastructure d'envoi (domaine vérifié, SPF/DKIM) appartient au
  transport.
- Une panne ne perd jamais de demande : persistance d'abord, retry avec
  backoff, relance admin, balayage de rattrapage (§3).

## 6. Analytics — rétention

- Défaut 90 jours (bornes 7–365), purge opportuniste + cron (§3).
- Aucune PII : pas d'IP stockée, session éphémère, DNT/GPC respectés —
  voir [privacy-data-map.md](privacy-data-map.md).

## 7. Nettoyage / hygiène

- Sessions admin expirées/révoquées : ignorées par les guards ; purge en
  cron optionnelle.
- Compteurs de rate limit : purge opportuniste existante.
- Contenus supprimés : soft delete (`deleted_at`) — le Core ne les sert
  plus nulle part ; la purge physique reste un choix du Project.

## 8. Variables de production

Voir [configuration.md](configuration.md) §2–3. Rappel des points
sensibles : `KREIZ_SECRET` unique par déploiement et présent au **build**
comme au runtime ; `KREIZ_STORAGE_PUBLIC_BASE_URL` requise au build dès
qu'un média est publié ; groupes storage/mail tout-ou-rien.

## 9. Monitoring attendu

| Signal | Où | Attendu |
|---|---|---|
| Build Vercel | dashboard Vercel | un build par publication demandée ; échec = site inchangé (DB fait foi) |
| Erreurs fonction `_render` | logs Vercel | surveiller 5xx sur `/admin/*` et `/api/*` |
| Audit `kreiz_admin_audit_log` | SQL | `site.rebuild_failed`, `contact.notification_failed` (avec `source: recovery`) sont les signaux d'incident |
| Médias `failed` | SQL `kreiz_media` | doit retourner à zéro après retry ; sinon intervention humaine |
| Notifications `failed`/`exhausted` | SQL `kreiz_contact_requests` | idem |

## 10. Répartition des responsabilités

**Le Core fournit** : moteur complet, guards, recovery functions, audit,
validation d'env, pages admin, build reader, beacon, SEO.

**L'hébergeur/le Project fournit** : PostgreSQL (Neon), stockage objet +
CDN, transport email, scheduler externe (cron), monitoring d'infrastructure,
backup DB/objets, secrets management.
