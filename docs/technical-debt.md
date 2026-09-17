# Registre de dette technique

> Slice 10 — inventaire honnête des compromis. Le bug `dummyPasswordVerify`
> est **corrigé** (commit `01e6798`) : il n'est pas une dette ouverte.
> La prochaine étape (revue sécurité globale du Core complet) reprendra
> ce registre.

Légende sévérité : 🔴 à traiter avant une mise en production réelle · 🟡
V2 ou lorsque le besoin apparaît · ⚪ scale-only (inoffensif à petit volume).

| # | Dette | Sévérité | Description et conséquence | État | Quand traiter |
|---|---|---|---|---|---|
| 1 | Rétention/suppression des demandes de contact | 🔴 | `kreiz_contact_requests` conserve des PII (nom, email, message) sans rétention ni suppression automatique — exposition RGPD grandissante. Le statut `handled` existe mais ne supprime rien. | ouvert | avant production : politique de rétention + purge (cron ou manuelle documentée) |
| 2 | Concurrence publish/unpublish | 🟡 | Deux publications simultanées du même contenu peuvent se croiser (pas de verrou transactionnel de bout en bout) ; le dernier snapshot écrit gagne. Aucune corruption observée (snapshot atomique par contenu), mais l'ordre n'est pas garanti sous concurrence extrême. | ouvert | V2 (verrou advisory ou version optimiste) |
| 3 | Non-atomicité de la publication | 🟡 | Publish = snapshot contenu + redirections + audit + rebuild en plusieurs transactions ; un crash intermédiaire laisse un état partiel cohérent-lecture mais incomplet (ex. snapshot sans redirect). | ouvert | V2 (transaction élargie ou outbox) |
| 4 | Migration CHECK future avec backfill | ⚪ | Les contraintes CHECK utiles nécessitant un backfill (ex. validation historique des colonnes JSONB) n'ont pas été posées en V1 pour garder les migrations réversibles. | assumé | V2 |
| 5 | Trafic admin dans les analytics | 🟡 | Le filtrage exclut `/admin` par préfixe de chemin mais pas « un visiteur qui serait aussi admin » ni tout le trafic provenant d'IP internes ; le dashboard peut compter du trafic équipe. | ouvert | V2 (flag session admin côté collecte) |
| 6 | Scheduler analytics retention | 🟡 | `runRetention` est opportuniste (dashboard) + disponible pour cron — sans cron configuré, la purge ne tourne que si un admin ouvre le dashboard. | ouvert | avant/après production selon exigences de rétention — cron externe documenté ([operations.md](operations.md) §3) |
| 7 | Médias `uploading` abandonnés | 🟡 | Un upload présigné jamais confirmé laisse une ligne `uploading` sans nettoyage automatique (aucune donnée sensible, encombrement de la médiathèque uniquement via état visible). | ouvert | V2 (balayage par ancienneté) |
| 8 | Suppression média DB/stockage non atomique | 🟡 | La suppression d'un média libre efface la ligne puis les objets ; un échec d'effacement objet laisse des orphelins sur le bucket (inverse : jamais de ligne sans objets servis). | ouvert | V2 (ordre inverse + balayage des orphelins) |
| 9 | Audit `disableAdmin` manquant | 🟡 | La désactivation d'un admin (via reset/CLI ou SQL direct) n'écrit pas d'événement d'audit dédié `admin.disabled` ; les sessions révoquées le sont de manière opaque. | ouvert | V2 (action d'audit dédiée) |
| 10 | Confiance `X-Forwarded-For` selon topologie | 🔴 | `clientIpFromHeaders` préfère `x-real-ip`/`x-vercel-forwarded-for` (non falsifiables sur Vercel) mais accepte `x-forwarded-for` en secours **local** : derrière un proxy qui ne nettoie pas ce header, l'IP de rate limiting est contrôlable par le client. | ouvert, **à vérifier dans la passe sécurité** selon la topologie de déploiement réelle | passe sécurité (avant production hors Vercel) |
| 11 | Garde mécanique CSRF exhaustive | 🟡 | L'invariant « toutes les mutations POST admin exigent le CSRF sessionnel » est couvert par tests et revue, mais pas par une **garde structurelle** unique (chaque route appelle le guard individuellement). | ouvert | V2 (middleware central) |
| 12 | Domaine couplé à certains types Drizzle | ⚪ | Quelques signatures de services/domaine exposent des types de lignes Drizzle (`KreizContactRequest`…) — frontière pratique, pas de fuite publique (internals). | assumé | V2 si un autre ORM/pilote apparaît |
| 13 | Scan des références média en JSONB | 🟡 | `collectRichTextMediaIds` scanne le JSONB du contenu pour protéger les médias référencés — pas d'index structurel ; coût borné par le volume éditorial, pas par le trafic. | assumé | scale-only |
| 14 | Migration du format rich text (V2 future) | 🚮→V2 | Le document canonique est versionné (`version: 1`) mais aucun chemin de migration de format n'existe encore — toute évolution du schéma exige un re-traitement des documents stockés. | assumé en V1 | V2 (migrateur versionné) |
| 15 | Machine à états média non branchée | ⚪ | `domain/media/lifecycle.ts` définit et teste les transitions autorisées, mais les services s'appuient sur les transitions gardées des repositories (équivalentes en pratique). Règle exprimée deux fois. | ouvert | V2 (brancher la machine dans les services) |
| 16 | Assets admin présents sur le CDN statique | ⚪ | Le bundle de l'éditeur (~462 Ko Tiptap) et l'CSS admin vivent dans `_astro/` (assets partagés de la sortie Vercel) : ils ne sont **référencés par aucune page publique**, mais restent téléchargeables par URL — inhérent à l'architecture Vercel une-fonction. | assumé | V2 (chunk séparé/obfuscation si jugé nécessaire) |

## Nettoyages effectués en slice 10

- suppression du baril interne mort `data/repositories/index.ts` ;
- retrait des factories de repositories de l'API publique
  `@kreiz/core/data` (internals — la garde d'exports reste intacte) ;
- correction du teardown des éditeurs Tiptap dans
  `tests/rich-text-adapter.test.ts` (erreurs non gérées faisaient échouer
  `pnpm test` alors que tous les tests passaient).
