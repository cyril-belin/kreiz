# Production readiness — Kreiz Core V1

> État au terme de la slice 10, **mis à jour par la revue sécurité finale**
> (slice 11 — détails dans [security-review-final.md](security-review-final.md)).
> Verdict de la revue : **CONDITIONALLY READY** — aucun finding CRITICAL,
> les findings HIGH/MEDIUM corrigés localement, les conditions restantes
> sont listées ci-dessous.

## READY

| Domaine | Justification |
|---|---|
| Build public | Vercel vérifié : pages statiques, sitemap/robots/beacon prérendus, redirections matérialisées, échec de rebuild sans dégât (E2E) |
| Migrations | chaîne possédée par l'app, replay 0000→fin vérifié identique, `drizzle-kit check` propre |
| Authentification admin | Argon2id (paramètres OWASP), sessions serveur révocables 14 j/90 j, rate limiting login, CSRF sessionnel, audit append-only (tests + E2E) |
| Pipeline média | presign → vérification réelle → variantes ; états explicites, retry/recovery ; suppression protégée par références |
| Moteur de contenu | Save ≠ Publish structurel, snapshots atomiques, preview noindex, isolation des types ; **unicité de l'espace d'URL public garantie en base** (index partiel 0006, revue finale) |
| Formulaires | anti-spam en couches, idempotence serveur, persistance avant notification (E2E panne → relance) ; **bail anti double-envoi** (0007) et cap de transport 1 MiB (revue finale) |
| Analytics | privacy-first (aucune IP stockée, DNT/GPC), rétention paramétrable, beacon statique ~2 Ko |
| Frontière de package | carte `exports` gardée mécaniquement, aucun deep import, aucun internal exposé |
| Tests | 736 tests verts (unitaires + intégration PostgreSQL réel), 10 specs E2E (84 tests) dont le parcours global — CI deux niveaux avec branche Neon éphémère |

## CONDITIONALLY READY

| Domaine | Condition |
|---|---|
| Formulaires de contact | fonctionnels et sans perte ; **rétention PII livrée** (passe de fermeture) : purge des `handled` anciens via `POST /api/maintenance` dès que le Project définit `KREIZ_CONTACT_RETENTION_DAYS` (30–730 j) — sans la variable, rétention illimitée (à configurer avant vrai trafic) |
| Analytics en production | purge de rétention à planifier (cron externe) si la rétention doit être honorée strictement (dette #6) |
| Déploiement hors Vercel | la confiance `x-real-ip`/`x-forwarded-for` doit être revue selon la topologie (dette #10, confirmée par la revue : sûr sur Vercel, HIGH ailleurs) — mitigations partielles livrées (/64 IPv6, purges bornées) |
| Scheduler/recovery | **endpoint de maintenance livré** (passe de fermeture) : `POST /api/maintenance` (bearer `KREIZ_MAINTENANCE_TOKEN`, refus par défaut, compteurs sans PII) enchaîne notification recovery, purge de rétention contact, médias collés, rétention analytics + rate limits — l'opérateur déclare l'entrée cron ([operations.md](operations.md) §3.1) |
| Médias en production | bucket + CDN + CORS à configurer ; objets orphelins possibles sur échec de suppression (dette #8) ; **CSP du Project à dériver de la configuration storage** (upload PUT cross-origin + images CDN — pattern dans `apps/demo/astro.config.ts`) |

## NOT YET READY

| Domaine | État |
|---|---|
| Revue sécurité finale / adversariale | **effectuée** (slice 11) — aucun CRITICAL ; 2 HIGH corrigés (inlining d'env dans le bundle, unicité des URL publiques) + 11 MEDIUM + 9 LOW traités ; verdict CONDITIONALLY READY ([security-review-final.md](security-review-final.md)) |
| RBAC / multi-rôles | hors périmètre V1 (conçu mono-admin, multi-comptes admin possibles sans rôles) |
| Workflow éditorial avancé, i18n complet, recherche full-text | hors périmètre V1 (documentés comme futur) |

## Lecture honnête

Un Project réel peut être construit et servi dès aujourd'hui (c'est l'objet
de la démo et du parcours E2E global). Mettre en production implique :
définir la rétention contact, planifier les crons de recovery, garder le
déploiement sur Vercel (ou valider la topologie des headers), et dériver la
CSP du Project de sa configuration storage. La revue sécurité finale (GLM) et la revue senior indépendante (Claude)
sont passées — aucune vulnérabilité critique/high nouvelle ; la passe de
fermeture a livré les dernières mécaniques (cron de maintenance, rétention
contact opt-in, concurrence optimiste des Saves, garde CI anti faux vert).
Conditions restantes : [security-review-final.md](security-review-final.md) §9.
