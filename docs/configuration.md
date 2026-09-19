# Configuration d'un Project Kreiz

> Référence unique (slice 10) : sections de la configuration Project,
> variables d'environnement, validation, dev vs production.

## 1. La configuration en code (`kreiz({...})`)

Toute la configuration **déclarative** vit dans `astro.config.ts` — jamais
dans des variables d'environnement modifiables à chaud. Elle est validée
fail-fast au chargement (schéma Zod strict : toute clé inconnue est
rejetée, jamais silencieusement ignorée).

| Section | Obligatoire | Par défaut | Rôle |
|---|---|---|---|
| `content.types[]` | non (site sans contenu éditorial) | — | Types de contenu (clé, label, namespace de route, champs, template) |
| `forms[]` | non | — | Formulaires de contact (clé, champs, chemin de confirmation, notification) |
| `seo` | non (mais recommandé) | — | Base canonique, nom du site, organisation, gabarit de titre. **Sans ce bloc : pas de canonical ni de sitemap URL** — le Core n'invente jamais une base |
| `analytics.enabled` | non | `true` | Collecte on/off ; `false` → endpoint muet, beacon stub |
| `analytics.retentionDays` | non | `90` (bornes 7–365) | Rétention des événements |
| `analytics.respectPrivacySignals` | non | `true` | DNT/GPC ⇒ aucune collecte |
| `analytics.excludedPaths[]` | non | `[]` (+ `/admin`, `/api` toujours exclus) | Préfixes publics supplémentaires à ne pas mesurer |

```ts
kreiz({
  content: { types: [articleType, guideType, caseStudyType] },
  forms: [contactForm],
  seo: defineSeoSiteConfig({
    siteName: 'Mon site',
    siteUrl: 'https://mon-site.fr',   // base canonique — jamais un Host
    locale: 'fr-FR',
  }),
  analytics: { enabled: true, retentionDays: 90 },
});
```

La configuration sérialisée vers le module virtuel retire les schémas
dérivés (`dataSchema`, `payloadSchema`) : la source de vérité reste les
descripteurs, re-dérivés côté runtime par la même fonction pure.

## 2. Variables d'environnement — référence centrale

Le Core ne lit `process.env` que dans **un seul fichier** serveur
(`src/http/server-env.ts`, validé par un schéma Zod à chaque requête admin)
plus deux lectures au **build** (redirections, sitemap). Les variables du
*Project* (ex. `KREIZ_SITE_URL` dans `apps/demo/src/seo.ts`) suivent la
même convention de préfixe.

### Noyau

| Variable | Obligatoire | Secret | Rôle | Phases |
|---|---|---|---|---|
| `KREIZ_DATABASE_URL` | oui (runtime admin, CLI, migrations) ; optionnelle au build (0 page au lieu d'échouer) | oui (credentials) | URL PostgreSQL Neon unique : runtime SSR, CLI, migrations, sitemap, `getStaticPaths` | build + runtime + CLI + tests |
| `KREIZ_SECRET` | oui (runtime) ; dégradée au build | oui | Clé HMAC (≥ 32 car.) : pseudonymisation des IP (rate limiting), signature des jetons de formulaire. **Au build aussi** (page contact statique) : sans elle, les soumissions sont refusées | build + runtime |

### Publication

| Variable | Obligatoire | Secret | Rôle |
|---|---|---|---|
| `KREIZ_REBUILD_DEPLOY_HOOK_URL` | non | oui (URL porteuse) | Deploy hook Vercel appelé après publication. Sans valeur : état « non configuré » explicite, publications sans rebuild. HTTPS imposé en production |

### Médias (groupe tout-ou-rien : les 4 premières ensemble ou aucune)

| Variable | Obligatoire | Secret | Rôle |
|---|---|---|---|
| `KREIZ_STORAGE_ENDPOINT` | conditionnelle | non | Endpoint S3-compatible (R2, MinIO, S3) |
| `KREIZ_STORAGE_BUCKET` | conditionnelle | non | Bucket (originaux privés, variantes publiques) |
| `KREIZ_STORAGE_ACCESS_KEY_ID` | conditionnelle | semi | Access key (presign SigV4) |
| `KREIZ_STORAGE_SECRET_ACCESS_KEY` | conditionnelle | oui | Secret key |
| `KREIZ_STORAGE_REGION` | non (défaut adaptateur, `auto` sur R2) | non | Région |
| `KREIZ_STORAGE_PUBLIC_BASE_URL` | conditionnelle (runtime) ; **requise au build dès qu'un média est publié** | non | Base publique (CDN) servant les variantes — résolution des couvertures/OG au build |

Sans ce groupe : la médiathèque est indisponible (état signalé), le reste
fonctionne.

### Notifications de contact (groupe tout-ou-rien : l'URL implique `KREIZ_MAIL_FROM_EMAIL`)

| Variable | Obligatoire | Secret | Rôle |
|---|---|---|---|
| `KREIZ_MAIL_WEBHOOK_URL` | non | oui (URL porteuse) | Relais email (POST JSON from/to/replyTo/subject/text). HTTPS imposé en production |
| `KREIZ_MAIL_WEBHOOK_TOKEN` | non (exige l'URL) | oui | `Authorization: Bearer` vers le relais |
| `KREIZ_MAIL_FROM_EMAIL` | requise si l'URL | non | Expéditeur d'enveloppe (adresse vérifiée chez le transport) |
| `KREIZ_MAIL_FROM_NAME` | non | non | Nom affiché (≤ 120 car.) |
| `KREIZ_MAINTENANCE_TOKEN` | non | oui | Token du endpoint de maintenance (`POST /api/maintenance`, cron externe) : `Authorization: Bearer`, comparaison temps constant, ≥ 32 car. **Sans valeur, le endpoint refuse tout (503)** |
| `KREIZ_CONTACT_RETENTION_DAYS` | non | non | Rétention (jours, 30–730, reco 180) des demandes de contact **traitées** — purge par lots via le endpoint de maintenance. Sans valeur : aucune purge automatique |

Sans relais : demandes stockées et visibles admin, statut
« notification non configurée ».

### Variables du Project demo (pas lues par le Core)

| Variable | Rôle |
|---|---|
| `KREIZ_SITE_URL` | Base canonique SEO du site demo (lue par `apps/demo/src/seo.ts`, repli `https://demo.kreiz.example`). Le Core reçoit toujours la base via la config en code |

### Tests uniquement

| Variable | Rôle |
|---|---|
| `KREIZ_TEST_DATABASE_URL` | PostgreSQL réel local (driver node-postgres) pour les tests d'intégration sans Neon ; applique la chaîne de migrations sur base vide |

### Audit (état slice 10)

- **aucune variable morte** : les 13 variables de `.env.example` sont toutes
  réellement lues ;
- **une variable était lue mais non documentée** (`KREIZ_SITE_URL`) :
  ajoutée à `apps/demo/.env.example` en slice 10 ;
- pas de doublon de nom, groupes tout-ou-rien vérifiés au runtime.

## 3. Dev vs production

| Sujet | Dev | Production |
|---|---|---|
| Base de données | branche Neon de dev (`apps/demo/.env`) | branche/Neon du déploiement |
| `KREIZ_SECRET` | valeur locale | **unique par déploiement** (`openssl rand -base64 32`), présente au build **et** au runtime |
| Rebuild | hook absent = publications sans rebuild (OK) | deploy hook Vercel configuré |
| Médias | MinIO local ou groupe absent | R2/S3 + CDN (`KREIZ_STORAGE_PUBLIC_BASE_URL`) |
| Mail | relais local ou absent | worker/endpoint interne, HTTPS |
| Jobs média | fire-and-forget | `waitUntil` (Vercel) |
| CSP | non supportée par Astro en dev | appliquée au build/production |
| Robots/noindex admin | en-têtes actifs | idem + preuve au build |

## 4. Incohérences de nommage (constat slice 10)

- `KREIZ_SITE_URL` porte le préfixe `KREIZ_` alors que le Core ne la lit
  pas : convention conservée (elle configure *un site Kreiz*), documentée
  ici pour lever l'ambiguïté — harmonisation jugée non nécessaire en V1.
- Le runtime admin lit l'env via le schéma validé ; les pages de build du
  Project lisent `process.env` directement : deux styles assumés (le Core
  ne force pas ses internes au Project).
