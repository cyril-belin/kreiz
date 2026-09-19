# Registre de dette technique

> Slice 10 — inventaire honnête des compromis. Le bug `dummyPasswordVerify`
> est **corrigé** (commit `01e6798`) : il n'est pas une dette ouverte.
> **Revue sécurité finale (slice 11)** : chaque entrée a été revérifiée dans
> le code — réévaluations dans la colonne État ; détails, preuves et
> corrections dans [security-review-final.md](security-review-final.md).

Légende sévérité : 🔴 à traiter avant une mise en production réelle · 🟡
V2 ou lorsque le besoin apparaît · ⚪ scale-only (inoffensif à petit volume).

| # | Dette | Sévérité | Description et conséquence | État | Quand traiter |
|---|---|---|---|---|---|
| 1 | Rétention/suppression des demandes de contact | 🟡→🟢 si configurée | La **mécanique est livrée** (passe de fermeture) : purge par lots des demandes traitées (`handled`) plus anciennes que `KREIZ_CONTACT_RETENTION_DAYS` (30–730 j, reco 180), appelée par `POST /api/maintenance`. Les demandes `new` ne sont jamais purgées automatiquement (aucune destruction sans décision explicite). | fermée **dès que le Project définit la variable + branche le cron** — sans variable, la rétention reste illimitée (décision opérateur explicite) | à la configuration du premier Project client |
| 2 | Concurrence publish/unpublish | 🟡 | Deux publications simultanées du même contenu peuvent se croiser (pas de verrou transactionnel de bout en bout) ; le dernier snapshot écrit gagne. Aucune corruption observée (snapshot atomique par contenu), mais l'ordre n'est pas garanti sous concurrence extrême. | ouvert | V2 (verrou advisory ou version optimiste) |
| 3 | Non-atomicité de la publication | 🟡 | Publish = snapshot contenu + redirections + audit + rebuild en plusieurs transactions ; un crash intermédiaire laisse un état partiel cohérent-lecture mais incomplet (ex. snapshot sans redirect). | ouvert | V2 (transaction élargie ou outbox) |
| 4 | Migration CHECK future avec backfill | ⚪ | Les contraintes CHECK utiles nécessitant un backfill (ex. validation historique des colonnes JSONB) n'ont pas été posées en V1 pour garder les migrations réversibles. **Note revue finale** : la migration 0005 (swap de vocabulaire `event_name` + bornes de longueur) échouerait au rejeu sur des données intermédiaires réelles — détaillé SRV-MIG. | assumé (note ajoutée) | V2 |
| 5 | Trafic admin dans les analytics | 🟡 | Le filtrage exclut `/admin` par préfixe de chemin mais pas « un visiteur qui serait aussi admin » ni tout le trafic provenant d'IP internes ; le dashboard peut compter du trafic équipe. | ouvert | V2 (flag session admin côté collecte) |
| 6 | Scheduler analytics retention | 🟢 mécanique livrée | `runRetention` est désormais **appelable par le cron externe** via `POST /api/maintenance` (passe de fermeture — [operations.md](operations.md) §3.1) et purge aussi les compteurs `kreiz_rate_limits` échus. Reste à l'opérateur : déclarer l'entrée cron et le token. | fermée côté Core ; activation Project | config Vercel Cron / scheduler externe |
| 7 | Médias `uploading` abandonnés | 🟡 | Un upload présigné jamais confirmé laisse une ligne `uploading` sans nettoyage automatique (aucune donnée sensible, encombrement de la médiathèque uniquement via état visible). | ouvert | V2 (balayage par ancienneté) |
| 8 | Suppression média DB/stockage non atomique | 🟡 | La suppression d'un média libre efface la ligne puis les objets ; un échec d'effacement objet laisse des orphelins sur le bucket (inverse : jamais de ligne sans objets servis). | ouvert | V2 (ordre inverse + balayage des orphelins) |
| 9 | Audit `disableAdmin` manquant | 🟡 | La désactivation d'un admin (via reset/CLI ou SQL direct) n'écrit pas d'événement d'audit dédié `admin.disabled` ; les sessions révoquées le sont de manière opaque. | ouvert | V2 (action d'audit dédiée) |
| 10 | Confiance `X-Forwarded-For` selon topologie | 🔴 | `clientIpFromHeaders` préfère `x-real-ip`/`x-vercel-forwarded-for` (non falsifiables sur Vercel) mais accepte `x-forwarded-for` en secours **local** : derrière un proxy qui ne nettoie pas ce header, l'IP de rate limiting est contrôlable par le client. **Revu (SRV-03)** : confirmé sûr sur Vercel, HIGH hors Vercel ; mitigations livrées (bucketisation IPv6 /64, purges bornées et régulières des compteurs) ; le modèle de confiance par topologie reste à configurer. | ouvert — **condition : Vercel-only jusqu'à configuration** | V2 (trust proxy configurable) |
| 11 | Garde mécanique CSRF exhaustive | 🟡 | L'invariant « toutes les mutations POST admin exigent le CSRF sessionnel » est couvert par tests et revue, mais pas par une **garde structurelle** unique (chaque route appelle le guard individuellement). | ouvert | V2 (middleware central) |
| 12 | Domaine couplé à certains types Drizzle | ⚪ | Quelques signatures de services/domaine exposent des types de lignes Drizzle (`KreizContactRequest`…) — frontière pratique, pas de fuite publique (internals). | assumé | V2 si un autre ORM/pilote apparaît |
| 13 | Scan des références média en JSONB | 🟡 | `collectRichTextMediaIds` scanne le JSONB du contenu pour protéger les médias référencés — pas d'index structurel ; coût borné par le volume éditorial, pas par le trafic. | assumé | scale-only |
| 14 | Migration du format rich text (V2 future) | 🚮→V2 | Le document canonique est versionné (`version: 1`) mais aucun chemin de migration de format n'existe encore — toute évolution du schéma exige un re-traitement des documents stockés. | assumé en V1 | V2 (migrateur versionné) |
| 15 | Machine à états média non branchée | ⚪ | `domain/media/lifecycle.ts` définit et teste les transitions autorisées, mais les services s'appuient sur les transitions gardées des repositories (équivalentes en pratique). Règle exprimée deux fois. | ouvert | V2 (brancher la machine dans les services) |
| 16 | Assets admin présents sur le CDN statique | ⚪ | Le bundle de l'éditeur (~462 Ko Tiptap) et l'CSS admin vivent dans `_astro/` (assets partagés de la sortie Vercel) : ils ne sont **référencés par aucune page publique**, mais restent téléchargeables par URL — inhérent à l'architecture Vercel une-fonction. | assumé | V2 (chunk séparé/obfuscation si jugé nécessaire) |

## Constats de la revue senior indépendante (Claude) — ouverts, non urgents

Inventaire honnête des observations de la seconde revue (aucune nouvelle
vulnérabilité critique/high) — restées ouvertes car hors périmètre de
fermeture V1 :

| Constat | Réalité | Quand traiter |
|---|---|---|
| Non-atomicité précise de `publishContent` | Publish = validation → redirections (delete+upsert+retarget) → `markPublished` → audit → rebuild, en requêtes séparées (limite neon-http) ; un crash entre deux étapes laisse un état lisible mais partiel (ex. redirection sans snapshot — republier répare) | V2 (transaction élargie/outbox) — déjà dette #3 |
| Sitemap > 50 000 URL / 50 Mo | `listPublishedForSitemap` n'est pas bornée ; au-delà des limites du protocole sitemap, il faudrait un sitemap-index | scale-only (dette #4-adjacente) |
| robots.txt staging non configurable | robots est prérendu depuis la config SEO du Project — un environnement de staging partage le robots de prod ; contournement : domaine de staging derrière un login ou header X-Robots-Tag au CDN | V2 (config robots par environnement) |
| Scan JSONB des références média | déjà dette #13 (scale-only, confirmé) | scale-only |
| Double source de vérité du lifecycle média | déjà dette #15 (confirmé) | V2 |
| Backend SigV4 réel non couvert en CI | la CI exerce s3rver (S3 local réel) ; un vrai R2/S3 n'est pas testé en CI (coût/credentials) — l'implémentation est prouvée contre les vecteurs officiels AWS | lors du premier branchement R2 réel (smoke test opérateur) |
| Liens internes rich text cassés non détectés | un lien `/articles/foo` vers un contenu supprimé rend une ancre 404 — pas de vérificateur de liens en V1 | V2 (vérification à la publication) |
| Types du module virtuel maintenus à la main | `src/virtual.d.ts` reflète manuellement la forme sérialisée du module — couvert par le typecheck croisé core/demo ; un drift casse le build, pas le runtime | V2 (génération si friction) |

## Corrections apportées par la revue sécurité finale (slice 11)

Sans changer l'architecture V1 : unicité de l'espace d'URL public (migration
0006), bail de notification anti double-envoi (migration 0007), suppression
de l'inlining d'environnement dans le bundle serveur, cap de transport du
formulaire public, `redirect: 'manual'` du mailer, sharp ≥ 0.35.4 (advisories
libvips/libheif), CSP Project dérivée de la configuration storage, cooldown
du rebuild manuel, variante de repli pour images étroites, attribution
analytics sur `published_slug`, purges bornées par lots, pré-scan de
profondeur rich text, gardes UUID/NUL/namespaces réservés/suffixes slug.
Détails complets : [security-review-final.md](security-review-final.md) §8.

## Nettoyages effectués en slice 10

- suppression du baril interne mort `data/repositories/index.ts` ;
- retrait des factories de repositories de l'API publique
  `@kreiz/core/data` (internals — la garde d'exports reste intacte) ;
- correction du teardown des éditeurs Tiptap dans
  `tests/rich-text-adapter.test.ts` (erreurs non gérées faisaient échouer
  `pnpm test` alors que tous les tests passaient).
