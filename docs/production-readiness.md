# Production readiness — Kreiz Core V1

> État au terme de la slice 10. Le Core n'est **pas** déclaré
> production-ready globalement : ce document sépare ce qui l'est, ce qui
> l'est sous conditions, et ce qui reste ouvert. La passe sécurité finale
> (prochaine étape) n'a **pas** été effectuée.

## READY

| Domaine | Justification |
|---|---|
| Build public | Vercel vérifié : pages statiques, sitemap/robots/beacon prérendus, redirections matérialisées, échec de rebuild sans dégât (E2E) |
| Migrations | chaîne possédée par l'app, replay 0000→fin vérifié identique, `drizzle-kit check` propre |
| Authentification admin | Argon2id (paramètres OWASP), sessions serveur révocables 14 j/90 j, rate limiting login, CSRF sessionnel, audit append-only (tests + E2E) |
| Pipeline média | presign → vérification réelle → variantes ; états explicites, retry/recovery ; suppression protégée par références |
| Moteur de contenu | Save ≠ Publish structurel, snapshots atomiques, preview noindex, isolation des types |
| Formulaires | anti-spam en couches, idempotence serveur, persistance avant notification (E2E panne → relance) |
| Analytics | privacy-first (aucune IP stockée, DNT/GPC), rétention paramétrable, beacon statique ~2 Ko |
| Frontière de package | carte `exports` gardée mécaniquement, aucun deep import, aucun internal exposé |
| Tests | 590+ unitaires, 17 fichiers d'intégration Neon, 10 specs E2E dont le parcours global — CI deux niveaux avec branche Neon éphémère |

## CONDITIONALLY READY

| Domaine | Condition |
|---|---|
| Formulaires de contact | fonctionnels et sans perte, **mais** rétention/suppression des PII à définir (dette #1) avant un usage réel |
| Analytics en production | purge de rétention à planifier (cron externe) si la rétention doit être honorée strictement (dette #6) |
| Déploiement hors Vercel | la confiance `x-forwarded-for` doit être revue selon la topologie (dette #10) — sur Vercel, headers non falsifiables |
| Scheduler/recovery | les fonctions de recovery existent et sont testées ; leur invocation exige un cron externe (documenté — [operations.md](operations.md) §3) |
| Médias en production | bucket + CDN + CORS à configurer ; objets orphelins possibles sur échec de suppression (dette #8) |

## NOT YET READY

| Domaine | État |
|---|---|
| Revue sécurité finale / adversariale | **non commencée** — prochaine étape dédiée sur le Core complet |
| RBAC / multi-rôles | hors périmètre V1 (conçu mono-admin, multi-comptes admin possibles sans rôles) |
| Workflow éditorial avancé, i18n complet, recherche full-text | hors périmètre V1 (documentés comme futur) |

## Lecture honnête

Un Project réel peut être construit et servi dès aujourd'hui (c'est l'objet
de la démo et du parcours E2E global). Mettre en production implique :
définir la rétention contact, planifier les crons de recovery, garder le
déploiement sur Vercel (ou valider la topologie des headers), et passer la
revue sécurité finale avant d'exposer des données visiteurs.
