# Slice 6 — Éditeur de contenu riche (Tiptap)

Statut : **terminé — en attente de revue**, 2026-09-15, base `main = d8ed0ef` (« feat: add media pipeline with presigned uploads and content covers »).

## Livré

- **Format canonique Kreiz `RichTextDocument`** — type métier versionné (`version: 1`), validé **serveur** par une whitelist stricte (nodes, marks, attributs, liens, bornes). Le JSON n'est jamais stocké tel quel : tout passe par `parseRichTextDocument()` / `coerceRichTextValue()`.
- **Champ de contenu `fields.richText(...)`** — premier champ non scalaire du moteur ; sa valeur stockée dans `data` est un **objet document validé** (jamais du HTML, jamais une chaîne arbitraire).
- **Éditeur Tiptap dans l'admin** (vanilla, sans React/Vue) : toolbar (paragraphe, H2, H3, gras, italique, barré, code, listes, citation, lien, séparateur, image, undo/redo), picker média réutilisant le pipeline slice 5, légende éditable par image, dialogues natifs `<dialog>`.
- **Renderer public déterministe** (`renderRichTextDocument`) : HTML sémantique whitelisté (p, h2/h3, ul/ol/li, blockquote, pre>code, a, hr, br, figure>picture>figcaption), texte intégralement échappé, médias rendus via `@kreiz/core/media` (variantes AVIF/WebP, fallback WebP, jamais l'original).
- **Médias du rich text intégrés au slice 5** : validation à la publication (existence, `ready`, alt non vide), résolution batch au build/preview, **suppression protégée** par les références rich text (courantes **et** snapshot, soft-deleted compris).
- **`@kreiz/core/rich-text`** — nouvelle API publique (types, politique, validation, extraction des références, renderer). Aucune interne Tiptap/ProseMirror n'est exposée.
- **Save ≠ Publish étendu au corps** : le snapshot `published_data` fige le document ; le lecteur de build ne lit que le snapshot.
- Démo : `article` et `guide` passent leur `body` en rich text ; templates publics rendus par `set:html` sur la sortie du renderer du Core (source unique prouvée).

## Dépendances ajoutées

| Paquet | Version | Justification |
| --- | --- | --- |
| `@tiptap/core` | ^3.31.3 | Moteur d'édition (mission §7). Charge **navigateur admin uniquement**. |
| `@tiptap/starter-kit` | ^3.31.3 | Nodes/marks de base, configurés explicitement (heading 2–3, `underline: false`, `link: false`). |
| `@tiptap/extension-link` | ^3.31.3 | Mark lien restreint : seul `href` est stocké ; validation par la politique Kreiz. |
| `jsdom` (devDependency) | ^27 | Test du contrat adaptateur ⇄ domaine sans navigateur. |

Aucun framework frontend, aucun sanitizer (le renderer n'accepte jamais de HTML brut), aucun package de page builder.

## Architecture

```
Admin (Tiptap, îlot JS)
  → document-adapter (tampon de version, traduction Tiptap ⇄ Kreiz)
  → POST form (input caché JSON + CSRF) → parseur HTTP → parseRichTextDocument()
  → data JSONB (brouillon)
Publish → validation (schéma + médias ready/alt) → snapshot published_data → audit → rebuild
Build public → lecteur (snapshot) → resolveContentViewModel → renderRichTextDocument → HTML statique
```

Règle fondamentale (mission §1) : **le domaine ne dépend pas de Tiptap**. Les seuls modules qui importent `@tiptap/*` sont `src/admin/richtext/editor.ts` et `src/admin/richtext/media-extension.ts` (vérifié par grep, frontière gardée par des tests). Le format Kreiz reste exploitable si l'éditeur disparaît.

### Fichiers créés / modifiés (Core)

Créés :
- `src/domain/content/rich-text/policy.ts` — version, bornes, politique de liens (`isAllowedRichTextLinkHref`, `externalLinkAttributes`) ;
- `src/domain/content/rich-text/document.ts` — types canoniques, schéma Zod strict, parse/coercition, blank, extraction médias ;
- `src/domain/content/rich-text/render.ts` — renderer déterministe ;
- `src/domain/content/rich-text/errors.ts` — codes stables + messages FR ;
- `src/rich-text/index.ts` — API publique `@kreiz/core/rich-text` ;
- `src/content/rich-text-media.ts` — résolution batch (strict build / best-effort admin) + validation de publication ;
- `src/admin/richtext/editor.ts`, `media-extension.ts`, `document-adapter.ts` — îlot Tiptap (adaptateur) ;
- `src/admin/lib/media-picker.ts` — items du picker (médias `ready`, miniatures variante WebP).

Modifiés : `fields.ts` (+ `richText`), `schema.ts` (cas richText), `view-model.ts` (`richText` + `RichTextFieldView`), `content-form.ts`, `admin/lib/content-page.ts`, `ContentFormFields.astro`, `content/edit.astro`, `content/new.astro`, `admin.css`, `services/publication.ts`, `services/media-admin.ts`, `services/content.ts`, `data/repositories/media.ts`, `content/reader.ts`, `content/index.ts`, `package.json` (exports + deps). Démo : `article.ts`, `guide.ts`, `ArticleContent.astro`, `GuideContent.astro`.

### Format RichTextDocument (mission §3/§4)

```json
{ "version": 1, "type": "doc", "content": [ /* nodes */ ] }
```

- **Nodes** : `paragraph`, `heading` (niveaux **2–3** — le h1 appartient au titre du contenu), `bulletList`, `orderedList`, `listItem`, `blockquote`, `horizontalRule`, `hardBreak`, `codeBlock` (texte sans marks), `media` (`{ mediaId, caption? }`), `text`.
- **Marks** : `bold`, `italic`, `strike`, `code`, `link` (`{ href }` seul — target/rel **jamais stockés**, décidés au rendu).
- **Bornes défensives** (§21) : 256 KiB de JSON, 2 000 nodes, profondeur 30, href ≤ 2 048, légende ≤ 500. Validation serveur obligatoire ; le navigateur n'est jamais source d'autorité.
- **Versioning** : version inconnue = refus explicite (`unknown-version`) ; l'adaptateur tamponne la version à la sortie de l'éditeur ; une fonction de migration future s'ajoutera dans `document.ts` sans toucher au stockage.

### Liens (§9)

Autorisés : `http:`, `https:`, `mailto:` absolus, et chemins internes `/…` (pas de `//` protocol-relative). Refusés : `javascript:`, `data:`, `vbscript:`, `file:`, schémas obfuscés (tab/saut de ligne — normalisés par le parser URL avant vérification), href trop longs. Politique de rendu déterministe : http(s) externe → `target="_blank" rel="noopener noreferrer"` ; mailto et interne → ancre simple. Revalidation au rendu (défense en profondeur) : un href invalide perd son ancre, pas son texte.

### Stockage et snapshots (§5/§6)

**Aucune migration SQL.** Le mécanisme générique existant est réutilisé : le document est un champ du JSONB `data` (brouillon) et `published_data` (snapshot figé par Publish) — un `body_document`/`published_body_document` dédié aurait **dupliqué** le système de snapshot (mission §5 : « ne duplique pas inutilement »). Le lecteur public ne lit que les snapshots, même invariant que la couverture (slice 5 §28).

### Médias dans le corps (§10–§14)

- Le node `media` stocke une **référence stable** `mediaId` (+ légende) — jamais d'URL présignée, jamais d'URL S3 brute, jamais d'`<img>` sérialisée, jamais de srcset.
- **Picker** : réutilise la médiathèque (`ready` uniquement, miniatures = plus petite variante WebP servie depuis la base publique). Pas d'upload inline en V1 (décision §11 — le pipeline présign/confirm/polling n'est pas dupliqué ; l'upload vit dans la médiathèque).
- **Suppression protégée (§13)** : `countContentReferences(mediaId)` = couvertures (`cover_media_id`/`published_cover_media_id`, FK) **+** références rich text via une requête JSONB structurelle :
  ```sql
  jsonb_path_exists(data, 'lax $.**.mediaId ? (@ == $id)', jsonb_build_object('id', $1::text))
  ```
  (descente récursive — même définition de « référence » que `extractRichTextMediaIds` ; contenus soft-deleted compris, invariant slice 5 conservé). Pas de recherche texte naïve.
- **Publication (§12)** : média inexistant, non `ready`, ou sans **alt non vide** → refus explicite avant toute écriture. Politique alt (§19) : l'alt public est l'**alt canonique du média** (source unique, pas d'override par document) et une image de corps éditorial est présumée informative → alt requis à la publication.
- **Édition (§12, choix)** : le Save d'un brouillon valide la **forme** du document mais pas l'existence/`ready` des médias — un brouillon reste éditable même si une référence devient indisponible (l'éditeur affiche « Média indisponible ou non prêt ») ; seule la publication invalide.

### Renderer public (§15/§16/§17)

Pure fonction `(document, { resolveMedia }) → string`. Tout le texte est échappé (`& < > " '`), les seuls tags émis sont ceux du renderer, les seuls attributs pilotés par la donnée sont `href` (revalidé) et `srcset/src/alt/width/height` (issus de la vue média slice 5). Paragraphes vides ignorés (décision déterministe). Les templates démo consomment `view.richText.<champ>.html` — le seul `set:html` autorisé, dont la source est prouvée être le renderer du Core (grep + revue).

### Adaptateur Tiptap (§7/§16/§20)

- Schéma de l'éditeur = contrat du domaine : StarterKit configuré (heading 2–3, `underline: false` — la commande n'existe même plus, `link: false`), Link restreint (`href` seul ; `isAllowedUri` = politique Kreiz partagée), node `media` personnalisé (jamais produit par du HTML collé hors forme clipboard interne).
- **Collage** : ProseMirror normalise via le schéma — styles, classes, ids et attributs d'événements retirés ; liens dangereux refusés au niveau de la mark (texte conservé).
- **Progressive enhancement (§23)** : le champ voyage en `<input type="hidden">` prérempli par le serveur ; l'îlot le synchronise (debounce 250 ms + synchronisation capture à la soumission). Sans JS, la valeur serveur repart inchangée — aucune corruption possible ; un bandeau `<noscript>` l'explique.
- **Concurrence (§24)** : inchangée (last-write-wins sur le Save, aucun système de révision ajouté). **Autosave (§25)** : aucun — Save explicite, conformément à l'existant.

### Tests

- **Unitaires** (`packages/core/tests/`) : `rich-text-document.test.ts` (27 — valides, invalides, version inconnue, node/mark inconnu, heading interdit, liens dangereux, bornes, coercition legacy, extraction, blank), `rich-text-render.test.ts` (17 — rendu sémantique, marks ordonnés, liens politiques, médias picture/srcset/caption, hostiles XSS), `rich-text-adapter.test.ts` (15, jsdom — contrat éditeur ⇄ domaine : JSON parseable, underline impossible, h1/h4 impossibles, setLink javascript refusé, href seul stocké, collage normalisé, insertion média, undo/redo), `rich-text-services.test.ts` (14 — publication refusée/acceptée, suppression protégée, vues strict/best-effort), extensions de `content-form.test.ts` (+6). Total suite unitaire : **363 verts**.
- **Intégration Neon** (`tests/integration/rich-text.test.ts`, 7 tests) : roundtrip JSONB, comptage JSONB réel (courante/publiée/imbriquée/soft-deleted/faux positifs), Save ≠ Publish sur le corps, refus (non ready / inexistant / sans alt) **sans aucune écriture ni audit**, suppression refusée puis autorisée après retrait, **contenu pré-slice 6** (ligne `article` au format ancien : lisible, modifiable, publiable), lecteur de build (HTML riche depuis snapshot ; média détruit hors service = échec explicite). Suite complète : **88 verts**. `public-build.test.ts` étendu : article riche publié → HTML statique final avec h2/ul/blockquote/liens (target/rel)/figure>picture>figcaption/srcset AVIF-WebP — et **garde de frontière de bundle** : page publique sans aucune balise `<script`, sans chaîne `tiptap`/`prosemirror`.
- **E2E Playwright** (`apps/demo/e2e/richtext.spec.ts`, 6 tests) : saisie réelle (gras, H2, liste) + reload restauré ; Save ≠ Publish corps (A public, Save B sans effet, Publish → B) ; média ready via picker + légende → figure en preview ; média non prêt (setup SQL) → Save OK, publication refusée (`publish_error=validation`) ; lien (javascript refusé dans le dialogue, href seul stocké, target/rel rendus) ; collage Word-like hostile normalisé. Suite complète : **38 verts**.

### Mesures (§38)

| Métrique | Valeur |
| --- | --- |
| Bundle admin ajouté (îlot Tiptap+ProseMirror, minifié) | 462 Ko bruts / **141 Ko gzip** — chargé uniquement par les pages d'édition admin |
| Runtime Tiptap dans le build public | **aucun** (garde d'intégration : page publique sans `<script`, sans chaîne `tiptap`/`prosemirror`) |
| HTML public d'un article riche de démo (h2+liste+citation+lien+figure) | **2,6 Ko** (~1,3 Ko gzip), 0 `<script` |

## Décisions et compromis

1. **Pas de colonne `body_document`** : le rich text est un **champ déclaré** du JSONB `data` — le snapshot générique `published_data` couvre Save ≠ Publish sans second mécanisme. Aucune migration SQL requise.
2. **Compat legacy contrôlée (§31/§32)** : un champ richText accepte au schéma la chaîne simple pré-slice 6 (`coerceRichTextValue` : paragraphes séparés par lignes vides, `hardBreak` sur les sauts simples). Conversion effective au premier Save ; lecture/rendu immédiats. Pas de migration magique destructrice.
3. **Alt : canonique et requis à la publication** (§19) — une image de corps est informative ; les images décoratives n'ont pas à être dans un corps rédactionnel. Pas d'override contextuel (source unique = médiathèque).
4. **Légende éditable dans le node** (input dans le NodeView) — donnée éditoriale stockée en `attrs.caption`, synchronisée transaction par transaction.
5. **Upload inline reporté** (§11) — le picker des médias `ready` suffit en V1 ; aucun pipeline dupliqué.
6. **Paragraphe vide non rendu** — bruit de saisie/collage ; décision déterministe, testée.
7. **Brouillon : médias non `ready` tolérés à la forme** — l'édition ne doit pas être bloquée par un état d'infrastructure ; la publication valide strictement.
8. **`codeBlock` sans coloration** — `<pre><code>` simple ; surlignage syntaxique hors slice (§40).
9. **Toolbar à boutons texte** (fr) — sobre, accessibles sans lib d'icônes ; `aria-pressed` + états disabled (undo/redo, retirer le lien).

## Auto-revue hostile pré-commit — résultats

Corrigés pendant la revue/revalidation :
- chaîne Tiptap non exécutée (`.run()` manquant) — la toolbar n'avait aucun effet ;
- `data-role="richtext-toolbar"` absent du markup — l'îlot ne câblait pas la toolbar ;
- mapping des attributs du node média (`data-media-id`) — un collage de la forme clipboard créait un node sans `mediaId` (refusé par le parseur) ;
- compte JSONB contaminé par les fixtures d'autres tests (dédicace des médias de comptage) ;
- assertions E2E calées sur les noms accessibles réels (`getByRole('textbox', { name: 'Titre' })` — les boutons « Titre de niveau 2/3 » entraient en collision `getByLabel`) ;
- assertion d'intégration corrigée : les `srcset` reflètent exactement les variantes produites (pas d'upscale — pas de 800.avif pour une source 1000 px ; attendu).

Vérifiés sans finding exploitable : frontière Tiptap ⇄ domaine (grep), stockage toujours validé (unique chemin d'écriture = services), XSS (tests hostiles : `<script>`, `on*`, faux nodes, attrs inattendus, texte `< > & "`), URLs dangereuses (sonde : `javascript:`/`data:`/`vbscript:`/`//`/tab-obscurcis → refus), snapshot (lecteur = published_*), publication partielle (validation avant écriture + pivot unique), suppression (count JSONB + FK RESTRICT), bundles publics (garde d'intégration), versioning (`unknown-version`), accessibilité (toolbar nommée + `aria-pressed` + disabled, dialogues natifs, `noscript`).

## Risques connus / reportés (non bloquants)

1. **Course comptage → suppression sur références JSONB** : contrairement aux couvertures (FK RESTRICT), une référence rich text ajoutée *entre* le comptage et le delete physique n'est pas protégée par la base. Fenêtre très étroite (action admin) ; conséquence bornée : un brouillon référençant un média supprimé reste éditable et la publication est refusée explicitement. Fermeture possible plus tard par une re-vérification dans la même transaction (driver neon-http : pas de transaction interactive).
2. **`seo.og_image_media_id` reste un comptage non couvert** (gap connu du slice 5, inchangé).
3. **Champ richText optionnel jamais édité** : le premier Save stocke un document vide (`{version:1,type:'doc',content:[]}`) au lieu d'omettre la clé — sémantiquement équivalent (rendu vide), convention « vide omis » conservée pour les scalaires.
4. **CSP du Project** : les miniatures (picker et médiathèque) pointent le domaine média public — le Project doit l'ajouter à `img-src` (préexistant depuis le slice 5 ; la config démo de référence le documente).
5. **Entrées pré-slice 6 adversariales** (corps texte > 2 000 paragraphes) : la coercition respecte les bornes du format → refus explicite ; données déjà hostiles avant ce slice.

## Validations exécutées

| Gate | Résultat |
| --- | --- |
| `pnpm lint` | ✅ 0 erreur |
| `pnpm typecheck` (core tsc + demo `astro check`) | ✅ 0 erreur |
| `pnpm build` (core tsc + assets + demo build Vercel) | ✅ |
| `pnpm test` (unitaires, jsdom adaptateur inclus) | ✅ 363 verts |
| `pnpm test:integration` (Neon réel, build Astro réel) | ✅ 88 verts |
| `pnpm test:e2e` (Playwright) | ✅ 38 verts |
| Données résiduelles | ✅ 0 ligne (contenus, médias, admins, audit) |

## État Git

HEAD de départ : `d8ed0ef` (« feat: add media pipeline with presigned uploads and content covers »)
Working tree : modifié, **non commité** — en attente de revue.
Aucun push. Slice 7 : **NON COMMENCÉE**.
