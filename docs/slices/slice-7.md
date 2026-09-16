# Slice 7 — Formulaires / contact

Statut : **terminé — en attente de revue**, 2026-09-16, base `main = 0a689da` (« feat: add rich text engine with Tiptap editor and canonical document format »).

## Livré

- **Capacité contact déclarée en code** (cadrage §13) — `defineContactForm()` : clé (`form_id`), libellé, description, vocabulaire de champs **borné** (`formFields.text | textarea | email | select | consent`), page de remerciement interne (`confirmationPath`), libellé de bouton, bloc `notification` optionnel (destinataires, sujet, `replyToField`). Aucun form builder, rien d'éditable depuis l'UI.
- **Rendu HTML public déterministe** (`renderContactFormHtml`) — POST classique `urlencoded`, **zéro JavaScript** requis ; labels/aides/placeholders/valeurs échappés, honeypot masqué (`hidden` + `aria-hidden` + `tabindex="-1"`), jeton d'émission signé en champ caché, re-rendu des erreurs avec valeurs conservées (`aria-invalid` + `role="alert"`). Les classes `kz-*` sont des points d'ancrage de style pour le Project — le Core ne livre aucune feuille de style publique.
- **Endpoint public SSR** `/api/forms/[key]` — la **seule route publique** injectée par l'intégration (hors `/admin`, jamais de session admin, garde mécanique dédiée dans `tests/admin-routes.test.ts`). PRG : succès → 303 vers la page de remerciement ; erreurs de validation → 422 avec formulaire re-rendu ; rate limit → 429 + `Retry-After` ; jeton invalide/expiré → 403 explicite ; formulaire inconnu → 404 sec ; cross-origin → 403 (avant toute résolution de registre).
- **Anti-spam en couches, sans dépendance externe** : jeton d'émission signé HMAC (possession d'une vraie page, âge maximal 90 j, non-signé = rejeté), honeypot, temps minimal de remplissage mesuré depuis l'émission du jeton, rate limiting PostgreSQL 5/10 min par (formulaire × hash d'IP), validation stricte du payload (schéma Zod dérivé, whitelist, bornes par champ, borne agrégée 32 KiB).
- **Idempotence des doubles soumissions** — clé de déduplication calculée **serveur** (HMAC du payload validé + hash d'IP + tranche de 10 min), index unique **partiel** en base, `INSERT … ON CONFLICT DO NOTHING` + relecture : un double POST concurrent ne crée qu'une ligne et le « perdant » reçoit la même réponse succès.
- **Port `Mailer` + adapter relais webhook** — contrat minimal (`send({ from, to, replyTo, subject, text }) → ok/unreachable/rejected`, même sémantique honnête que `RebuildTrigger`). Aucun fournisseur imposé : l'adapter de référence (`adapters/mailer/webhook.ts`) POSTe le message préparé en JSON vers une URL du Project (`KREIZ_MAIL_WEBHOOK_URL`, HTTPS imposé en production, Bearer optionnel) ; sans relais, la demande est stockée et marquée `not_configured`, sans erreur fonctionnelle.
- **Persistance avant notification** — la demande est écrite AVANT toute tentative d'envoi : une panne du transport ne perd jamais une soumission (jamais d'erreur visible de l'expéditeur). Cycle de notification explicite : `not_configured | pending | sent | failed` (+ tentatives, kind d'échec borné, prochaine échéance, `notified_at`), backoff automatique (2 min → 10 min → 1 h → 6 h, plafond 5 tentatives), relance admin, **balayage de rattrapage** prêt pour un cron futur (promotion des `not_configured` quand un transport apparaît, reprise des échues, claim conditionnel anti double-envoi).
- **Boîte de contact admin** — liste bornée (200, plus récentes d'abord, filtre « non traitées » + compteur), détail (payload rendu avec les labels de la déclaration, état de notification, raison d'échec bornée), actions progressives sans JS : marquer traité/rouvrir (audit `contact.status_changed`), renvoyer la notification. Nav admin activée (« Commercial → Boîte de contact »), compteur sur le dashboard.
- **Démo** — formulaire `contact` déclaré (nom, email, sujet select, message, consentement RGPD), pages statiques `/contact` et `/contact/merci`, notification vers un destinataire de démonstration.

## Dépendances ajoutées

**Aucune.** Le port `Mailer` et l'adapter webhook utilisent `fetch` global ; l'anti-spam réutilise le secret et le rate limiting PostgreSQL existants ; le rendu est une fonction pure (même philosophie que le renderer rich text du slice 6).

## Migration

`apps/demo/drizzle/0004_parallel_wasp.sql` (appartenant à l'app, générée par drizzle-kit depuis le schéma composé) — `ALTER TABLE kreiz_contact_requests` :

- colonnes `notification_status` (défaut `not_configured` — sémantique honnête pour les lignes héritées pré-slice 7), `notification_attempts`, `notification_failure` (jsonb borné `{kind, statusCode?}`), `notified_at`, `notification_next_attempt_at`, `dedup_key` (nullable) ;
- CHECK `notification_status in ('not_configured','pending','sent','failed')` ;
- index unique **partiel** `kreiz_contact_requests_dedup_key_unique` (`WHERE dedup_key IS NOT NULL`) — l'arbitre concurrentiel de l'idempotence ;
- index partiel de file d'attente `kreiz_contact_requests_notification_due_idx` (pending/failed dues) pour le balayage ;
- index de tri `kreiz_contact_requests_form_created_idx`.

Testée sur **PostgreSQL réel** : branche Neon migrée (`pnpm db:migrate`) **et** rejeu de l'historique complet `0000 → 0004` dans un schéma isolé (`tests/integration/contact-migration.test.ts` : colonnes/défauts, CHECK, unicité partielle 23505, lignes héritées sans `dedup_key`).

## Architecture

```
Page statique du Project (/contact, build)
  → renderContactFormHtml (jeton signé au rendu, honeypot)
  → POST /api/forms/[key] (SSR, hors /admin, Origin/Sec-Fetch vérifiés)
  → parse whitelist (champs déclarés seuls) → borne 32 KiB
  → service contact :
      honeypot → rate limit (hash d'IP) → jeton (HMAC, âge)
      → temps min. de remplissage → schéma dérivé (strict, borné)
      → INSERT … ON CONFLICT (dedup_key) → demande persistée
      → Mailer (port) → adapter webhook → relais du Project
      → sent / failed(+backoff) / not_configured → audit
  → 303 page de remerciement (PRG) — ou re-rendu 422/429/403

Admin : /admin/forms (liste) → /admin/forms/[id] (détail)
  → marquer traité ⇄ nouveau (audit) · renvoyer la notification
Cron futur : contact.runNotificationRecovery() (claim conditionnel)
```

Règles d'enveloppe **anti open-relay structurelles** : `to` = déclaration en code, `from` = env serveur, `reply-to` = unique champ email validé (`isSafeEmailAddress` — aucun CR/LF/caractère de contrôle), `subject` = déclaration validée sans contrôle. Aucune entrée visiteur ne devient une adresse d'enveloppe, quel que soit le POST (champs `recipients`/`to`/`bcc`/`subject` injectés = ignorés par la whitelist).

### Fichiers créés / modifiés (Core)

Créés :
- `src/domain/forms/policy.ts` — bornes, défauts (5/10 min, fenêtre de dédup 10 min, backoff, plafond 5 tentatives, jeton 90 j, min-fill 3 s, payload 32 KiB), validators purs (`isSafeEmailAddress`, `isSafeHeaderValue`, `isInternalConfirmationPath`, `publicFormSubmitPath`) ;
- `src/domain/forms/fields.ts` — vocabulaire de champs, builders `formFields`, schéma Zod dérivé (préprocesseur « champ absent = vide », strictObject, omission des vides), mapping FR des issues ;
- `src/domain/forms/token.ts` — jeton d'émission (émission, vérification temps constant, re-signature conservant l'instant d'émission pour le re-rendu d'erreurs) ;
- `src/domain/forms/declaration.ts` + `registry.ts` — `defineContactForm` (fail fast : clé, honeypot, chemin interne, destinataires/sujet validés), registre runtime ;
- `src/domain/forms/render.ts` — renderer HTML public ;
- `src/ports/mailer.ts`, `src/adapters/mailer/webhook.ts` — port + adapter de référence ;
- `src/services/contact.ts` (+ `contact-audit.ts`) — orchestration complète, relance, balayage ;
- `src/data/repositories/contact-requests.ts` — dédup `ON CONFLICT`, claim conditionnel, file du balayage, promotion ;
- `src/http/public-form.ts` — parseur whitelist, borne agrégée, re-rendu, pages autonomes (422/429/403) ;
- `src/forms/public-submit.ts` (route publique injectée), `src/forms/runtime.ts` (registre via module virtuel), `src/forms/index.ts` (API publique `@kreiz/core/forms`) ;
- `src/admin/pages/forms/index.astro` + `detail.astro`, `src/admin/routes/forms-status.ts` + `forms-notify.ts`.

Modifiés : `config.ts` (section `forms` revalidée, `payloadSchema` non sérialisé), `server-env.ts` (bloc mail tout-ou-rien + `mailer`/`mailFrom`/`secret` au runtime), `admin-runtime.ts` (service contact), `admin-routes.ts` (+4 routes admin, `PUBLIC_ROUTE_PATTERNS`), `integration.ts` (+5 routes injectées), `data/index.ts`, `data/tables/contact-requests.ts`, `AdminShell.astro` (nav), `admin/pages/index.astro` (dashboard), `package.json` (export `./forms`). Démo : `astro.config.ts`, `src/forms/contact.ts`, `src/pages/contact*.astro`, `.env.example`, index.

## Anti-spam : lectures honnêtes

- **Sur une page statique**, le jeton est émis au build : le temps minimal de remplissage y est trivialement satisfait — la couche réelle y est la **possession d'un jeton signé** (les bots qui POSTent à l'aveugle sont rejetés) plus l'**âge maximal** (jetons récoltés sur un vieux build morts après 90 j). Le temps minimal devient pleinement discriminant pour tout HTML servi à la demande (re-rendus d'erreurs, pages SSR du Project) — et l'E2E l'exerce réellement sur le dev server. Un Turnstile optionnel resterait un ajout derrière le même service.
- **Sans `KREIZ_SECRET` au build** (fork PR), le formulaire s'affiche avec un jeton non signé que le runtime **rejettera** — un déploiement sans secret est déjà cassé (admin + rate limiting) ; le formulaire ne fait pas semblant.
- La clé d'idempotence est **calculée serveur** : aucun jeton client n'est cru. Fenêtre de 10 min : un renvoi légitime au-delà crée une nouvelle demande ; deux visiteurs distincts (IP différentes) ne fusionnent jamais.

## Tests

- **Unitaires** (`packages/core/tests/`, +84) : `forms-declaration.test.ts` (déclarations valides/invalides, anti open-relay structurel, schéma dérivé : trim/omission/requis/bornes/select fermé/emails hostiles/whitelist stricte, validators purs, registre), `forms-token.test.ts` (signature, falsification de l'instant, mauvais formulaire, expiration, non-signé rejeté, re-signature conservant l'émission), `forms-render.test.ts` (POST sans script, honeypot masqué, échappement intégral, valeurs/erreurs re-rendues), `forms-parse.test.ts` (whitelist, honeypot non lu, overrides ignorés, troncature défensive, borne agrégée, re-rendu), `contact-service.test.ts` (persistance avant envoi, `not_configured`, honeypot/min-fill silencieux, rate limit par IP, idempotence incl. ordre de clés, panne mail sans perte, relance admin, claim concurrent unique, plafond d'attempts → terminal, balayage : dues/promotion/skip), `webhook-mailer.test.ts` (POST JSON, Bearer, 503 → rejected, connexion coupée → unreachable, HTTPS imposé), extensions de `config.test.ts` (+ formulaires) et `admin-routes.test.ts` (garde de la route publique hors `/admin`). Suite : **447 verts**.
- **Intégration Neon** (`tests/integration/`) : `contact.test.ts` (9 — dédup réelle 23505-arbitrée, claim concurrent sur vraie base, cycle de notification complet, service bout en bout avec rate limiting en table, idempotence de bout en bout, panne + relance admin, promotion `not_configured` → sent) ; `contact-migration.test.ts` (5 — historique complet `0000→0004` rejoué dans un schéma isolé). Suite : **102 verts**. `public-build.test.ts` : build Astro réel toujours vert (page contact prérendue incluse).
- **E2E Playwright** (`apps/demo/e2e/forms.spec.ts`, 20) : parcours UI complet + notification capturée (enveloppe exacte : to/reply-to/subject/from), **soumission sans JavaScript** (contexte JS désactivé), idempotence double POST, validation serveur 422 (requis, email, consentement RGPD, valeurs conservées), honeypot silencieux, soumission instantanée silencieuse, jeton falsifié/absent/d'autre formulaire → 403, cross-origin → 403, rafale → 429 + Retry-After, clé inconnue → 404, override des destinataires ignoré, injection CRLF refusée, **panne du relais : soumission acceptée, demande `failed`, relance admin → `sent`**, marquer traité + audit, `/admin/forms` non authentifié → login, endpoint public sans session admin. Serveur de relais local contrôlé (`mail-capture-server.ts`, ports 43990-43992 dédiés). Suite complète : **58 verts**.

## Auto-revue hostile — résultats

Corrigés pendant la revue (puis validations rejouées intégralement) :
1. **Relance concurrente pouvant écraser un succès** : `markNotificationFailed` inconditionnel pouvait transformer un `sent` en `failed` si une tentative en vol échouait après une relance admin réussie → UPDATE conditionnel `WHERE notification_status <> 'sent'` (conséquence évitée : doublon d'email au balayage suivant).
2. **Balayage non tolérant au retrait du bloc notification** : un formulaire dont le bloc `notification` a été supprimé du code faisait lever `buildNotificationEmail` dans le balayage → skip explicite (la demande reste visible/relançable, jamais écrasée).
3. **Énumération des formulaires** : le 404 « clé inconnue » était répondu avant la vérification same-site — un probe cross-origin distinguait clés existantes/inexistantes → contrôle d'origine déplacé avant la résolution du registre.
4. **`KREIZ_MAIL_FROM_NAME` non validé** (caractères de contrôle possibles dans un en-tête d'affichage) → `.refine(isSafeHeaderValue)` dans le schéma d'env.
5. **Champs requis totalement absents du POST** (checkbox décochée non envoyée) produisaient une issue Zod `invalid_type` avec un message anglais brut → préprocesseur « absent = vide » dans le schéma dérivé : messages FR stables (« Ce champ est requis. », « Vous devez cocher cette case. »).
6. Constante morte supprimée (`CONTACT_FIELD_VALUE_MAX_BYTES`).

Vérifiés sans finding exploitable : open relay (destinataires/sujet = code, `reply-to` unique email validé, overrides POST ignorés — E2E dédiés), injection d'en-têtes (validators sans contrôle, temps constant sur la signature), PII (pas d'IP/UA stockés — hash HMAC en rate-limit/dédup uniquement ; audit sans donnée visiteur ; grep `console.*` négatif sur tout le nouveau code), secrets (jamais rendus/loggués ; jeton public sans secret), auth admin (guards + CSRF + same-site, E2E non-authentifié refusé), mauvaise config env (bloc mail tout-ou-rien, HTTPS imposé hors dev, jeton non signé rejeté), concurrence (index unique + claim conditionnel, tests `Promise.all` sur PG réel), bundle public (0 `<script` sur les pages contact buildées + garde d'intégration), données résiduelles (0 ligne sur toutes les tables après suite complète).

## Risques connus / reportés (non bloquants)

1. **Notification at-least-once** : un crash entre l'envoi réussi et `markNotified` provoquera une reprise (doublon chez le destinataire) — préféré à la perte ; le claim conditionnel borne la fenêtre à un crash process.
2. **Course à la frontière de tranche de dédup** : deux POST identiques à cheval sur deux tranches de 10 min créent deux lignes — le PRG et le disable-on-submit couvrent l'usage réel ; la dédup est un filet, pas une garantie absolue.
3. **Jeton de build périmé** : un site non reconstruit pendant > 90 jours refuse les soumissions (message : recharger/reconstruire) — cohérent avec « le site public change au build » ; ajustable plus tard.
4. **Fenêtre promotion → balayage** : `promoteNotConfigured` (limite 50) et la reprise des échues sont deux étapes non transactionnelles — un balayage rapproché est idempotent (claim), aucune perte possible.
5. **IP absente des headers plateforme** : tous les clients sans IP partageaient une seule fenêtre de rate limit (fail-closed, choix assumé) — Vercel fournit toujours `x-vercel-forwarded-for`.
6. **Turnstile/CAPTCHA optionnel** non livré — la couche reste branchée derrière le service quand un projet en démontrera le besoin.
7. **HTML des pages d'erreur (422/429/403) non stylé par le Core** — sémantique et lisible sans CSS ; le Project peut cibler les classes `kz-*` (sa CSP, ses styles).

## Validations exécutées (ordre demandé)

| Gate | Résultat |
| --- | --- |
| `pnpm lint` | ✅ 0 erreur |
| `pnpm typecheck` (core tsc + demo `astro check`) | ✅ 0 erreur |
| `pnpm test` (unitaires) | ✅ 447 verts |
| `pnpm test:integration` (Neon réel, build Astro réel, migrations historique complet) | ✅ 102 verts |
| `pnpm build` (core + demo build Vercel) | ✅ |
| `pnpm test:e2e` (Playwright) | ✅ 58 verts (38 préexistants + 20) |
| Données résiduelles | ✅ 0 ligne (contact_requests, audit, rate_limits, contenus, médias, admins, sessions, redirects, analytics) |

## État Git

HEAD de départ : `0a689da` (« feat: add rich text engine with Tiptap editor and canonical document format ») — inchangé.
Working tree : modifié (22 fichiers modifiés, 27 créés), **non commité** — en attente de revue.
Aucun push. Slice 8 (analytics) : **NON COMMENCÉE**.
