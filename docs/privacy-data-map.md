# Cartographie des données (privacy / data map)

> Inventaire par table (slice 10) — input de la future passe
> sécurité/compliance. « Rétention » décrit l'état **actuel** du code.

| Table | Type de donnée | PII | Origine | Usage | Rétention actuelle | Suppression | Public/Private |
|---|---|---|---|---|---|---|---|
| `kreiz_admin_users` | compte administrateur : email, hash Argon2id, nom, `disabled_at` | **oui** (email, nom) | CLI `kreiz admin:create` / reset | authentification back-office | vie du compte ; pas de purge automatique | suppression SQL (Project) — révoque les sessions en cascade | privée |
| `kreiz_admin_sessions` | hash SHA-256 du token de session (le token brut n'existe qu'en cookie), horodatages d'expiration | non (lien vers admin) | login admin | session serveur révocable | 14 j glissants / 90 j absolus — les lignes expirées restent jusqu'à purge (ignorées par les guards) | logout (révocation) ; purge cron optionnelle | privée |
| `kreiz_admin_audit_log` | journal append-only : acteur, action, entité, metadata minimales | non (IDs techniques) | toutes les mutations admin + événements système (acteur NULL) | traçabilité, monitoring opérationnel | illimitée (append-only) | jamais automatiquement (choix assumé) | privée |
| `kreiz_content_entries` | contenus éditoriaux : `data` JSONB validé (dont documents riches canoniques), SEO éditorial, slug, statut, snapshots `published_*`, `deleted_at` (soft delete) | selon champs du Project (la démo n'en stocke pas) | formulaires admin | back-office + **site public via les snapshots uniquement** | vie du contenu ; soft delete à la suppression | soft delete (UI) — purge physique au choix du Project | privée (la version `published_*` est publique par construction) |
| `kreiz_redirects` | `from_path` → `to_path` 301, lien contenu optionnel | non | publication avec changement de slug | redirections matérialisées au build | tant que la cible est vivante ; nettoyage à l'écriture | automatique (cible morte / boucle) | publique (sémantique) |
| `kreiz_media` | métadonnées : MIME, dimensions, taille, alt, clés de stockage, variantes, `failure_reason`, `uploaded_by` | non (alt = texte éditorial) | upload admin | médiathèque, couvertures, corps riches, OG | vie du média | suppression UI (refusée si référencé) | métadonnées privées ; **objets variantes publics** sur le CDN |
| `kreiz_contact_requests` | `payload` JSONB : nom, email, sujet, message, consentement (champs du formulaire déclaré) ; statut de traitement ; état de notification (`pending`/`failed`/`sent`, tentatives, `notification_failure` JSON) | **oui** (nom, email, message) | formulaire public | boîte de contact admin + notifications | **illimitée à ce jour — dette** (voir [technical-debt.md](technical-debt.md)) | statut `handled` (UI) ; suppression/rétention à la charge du Project | privée |
| `kreiz_analytics_events` | `event_name` (vocabulaire fermé), `path` (sans query), `referrer` réduit au domaine, `session_id` (UUID éphémère d'onglet, nullable), `locale`, 5 UTM whitelistés, `device_class`, `dedup_key` | **non** — aucune IP, aucun User-Agent brut, aucune query string, aucune donnée de formulaire | beacon public + conversions serveur | dashboard admin agrégé | **90 jours par défaut** (7–365), purge opportuniste + cron | purge automatique (`runRetention`) ; `content_entry_id` en SET NULL | privée (agrégats consultables admin) |
| `kreiz_rate_limits` | clé HMAC (IP/email pseudonymisées), compteur fenêtré | non (pseudonymisée par HMAC avec `KREIZ_SECRET`) | guards (login, formulaires, analytics) | anti-abus | fenêtres glissantes (15 min login, 10 min contact) ; purge opportuniste | automatique (expiration) + purge | privée |

## Points saillants

1. **Aucune IP n'est jamais stockée** : les rate limits n'en conservent
   qu'un HMAC (clé de déploiement), les analytics n'en conservent rien.
2. **Le beacon n'emporte aucune PII** : session `sessionStorage` éphémère
   par onglet, DNT/GPC ⇒ aucune requête émise, referrer réduit au domaine.
3. **Les conversions analytics ne contiennent aucune donnée du
   formulaire** (prouvé par E2E : l'email et le message d'une soumission
   n'apparaissent jamais dans les événements).
4. **Le site public ne lit que les snapshots `published_*`** : un brouillon
   ou une donnée non publiée ne peut pas fuiter dans le HTML servi.
5. **Rétentions ouvertes** (dette) : `kreiz_contact_requests` (PII à durée
   illimitée) et `kreiz_admin_audit_log` (append-only assumé) — voir le
   registre de dette.
6. Objets storage : originaux **privés** (jamais référencés par le site),
   variantes publiques immuables.
