# Handoff — Kreiz Core V1

> Document de reprise (slice 10) : permettre à un développeur compétent de
> reprendre Kreiz sans reconstituer l'histoire des slices.

## État actuel (septembre 2026)

- **Kreiz Core V1 est complet** : dix slices livrées et vérifiées
  (fondations, données, auth admin, contenu, publication/redirects,
  médias, rich text, formulaires, analytics, SEO) + interlude sécurité.
- Monorepo : `packages/core` (`@kreiz/core`) + `apps/demo` (consommateur
  de référence, API publique uniquement).
- Toute la documentation de référence est dans `docs/` :
  [architecture.md](architecture.md) · [api.md](api.md) ·
  [configuration.md](configuration.md) · [build-a-project.md](build-a-project.md) ·
  [operations.md](operations.md) · [privacy-data-map.md](privacy-data-map.md) ·
  [technical-debt.md](technical-debt.md) ·
  [production-readiness.md](production-readiness.md) · journal par slice
  dans `docs/slices/`.

## Commandes

```sh
pnpm install && pnpm build          # build core (dist/) puis demo (topologique)
pnpm lint                           # eslint
pnpm typecheck                      # tsc core + astro check demo
pnpm test                           # vitest unitaire (intégration sauvée sans DB)
pnpm test:integration               # contre $KREIZ_DATABASE_URL (Neon) ou $KREIZ_TEST_DATABASE_URL
pnpm test:e2e                       # Playwright (apps/demo — nécessite le build du core + une DB)
pnpm db:generate / pnpm db:migrate  # migrations (possédées par apps/demo)
pnpm --filter @kreiz/core exec kreiz admin:create   # CLI premier admin
```

## Environnement

`apps/demo/.env` (voir `.env.example` commenté et
[configuration.md](configuration.md) pour la référence complète) :
`KREIZ_DATABASE_URL` + `KREIZ_SECRET` obligatoires ; groupes optionnels
tout-ou-rien : `KREIZ_REBUILD_DEPLOY_HOOK_URL`, `KREIZ_STORAGE_*` (5),
`KREIZ_MAIL_*` (4) ; `KREIZ_SITE_URL` (Project demo). Aucune variable
morte, aucune variable lue non documentée (audit slice 10).

## Base de données

- Neon PostgreSQL, driver HTTP serverless côté Core.
- Schéma **composé par l'app** (`defineCoreTables()`), chaîne de migrations
  dans `apps/demo/drizzle/` (0000 → 0005, vérifiée : replay intégral
  identique, aucun drift).
- 9 tables `kreiz_*` + tables du Project — cartographie complète dans
  [privacy-data-map.md](privacy-data-map.md).

## Build / déploiement

- `output: 'static'` + adapter Vercel : le site public est **prérendu** ;
  le runtime dynamique est une fonction unique `_render` couvrant
  `/admin/*`, `/api/*` et le fallback.
- Statique : pages publiques, `sitemap.xml`, `robots.txt`,
  `api/analytics/beacon.js`, assets `_astro` (dont le bundle admin — non
  référencé par les pages publiques, inhérent à l'architecture Vercel).
- Publication → deploy hook → rebuild ; les redirections 301 sont injectées
  dans la config Astro au build (cibles vivantes uniquement).

### Baseline de performance observée (build démo, base vide)

| Métrique | Valeur |
|---|---|
| Beacon analytics | 1 980 octets |
| HTML public (index / contact) | ~4–5 Ko |
| CSS public (global) | ~12 Ko |
| Bundle éditeur admin (Tiptap, chargé uniquement par l'admin SSR) | ~462 Ko |
| Routes dynamiques | 29 règles → 1 fonction `_render` |
| Pages statiques | 4 pages + 404 + robots + sitemap + beacon (base vide) — 1 page par contenu publié |
| Temps de build démo (prerender + server) | ~4 s sur station de dev |

## Tests

- 69 fichiers / **736 tests verts** (unitaires + intégration PostgreSQL
  réel, mis à jour par la revue sécurité finale) ; 10 specs E2E Playwright
  dont **le parcours global** (`core-happy-path.spec.ts` : média → article
  riche → publish → public → analytics → contact → conversion →
  Save-sans-Publish → republier) et **le recovery** (`core-recovery.spec.ts`
  : panne mail → relance admin → livré + audit) — **84 tests E2E verts** en
  suite complète (re-passés après la revue).
- CI GitHub Actions : `quality` (lint/build/typecheck/unit, toujours) et
  `integration` (branche Neon éphémère : migrations → intégration → E2E →
  suppression, secrets réservés au repo d'origine).

## Recovery

Fonctions explicites sans scheduler interne — voir la table de référence
dans [operations.md](operations.md) §3 (médias failed/stuck, notifications
de contact, rétention analytics, purge rate limits). Les fréquences
conseillées et le cron externe attendu y sont documentés.

## Dettes et limitations

Registre complet : [technical-debt.md](technical-debt.md). Points
sensibles avant une vraie production : rétention des PII contact (#1),
topologie `x-forwarded-for` hors Vercel (#10), rétention analytics sans
cron (#6). Limitations V1 assumées : mono-admin (pas de RBAC), pas de
workflow multi-étapes, pas d'i18n complet, pas de recherche, pas de
scheduler interne.

## Revue sécurité finale + passe de fermeture — effectuées (slice 11)

La revue adversariale du Core complet (GLM) a été menée (aucun CRITICAL ;
2 HIGH corrigés — inlining d'environnement dans le bundle serveur, unicité
des URL publiques — plus 11 MEDIUM et 9 LOW traités ; migrations
0006/0007), puis une revue senior indépendante (Claude, sans modification)
a confirmé architecture/code/sécurité solides et CONDITIONALLY READY, et la
**passe de fermeture** a livré les derniers écarts : `POST /api/maintenance`
(cron externe, bearer dédié), rétention PII contact opt-in, concurrence
optimiste des Saves (`expected_updated_at`), garde CI anti faux vert
(`KREIZ_REQUIRE_INTEGRATION_DB`), guard préconditions Astro. Rapports et
conditions restantes : [security-review-final.md](security-review-final.md)
et [technical-debt.md](technical-debt.md) (constats Claude ouverts).
