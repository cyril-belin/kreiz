# API publique de `@kreiz/core`

> Référence de la surface **réellement supportée** (slice 10). Chaque
> sous-chemin de la carte `exports` est documenté avec son but, ses
> principaux symboles, son contexte d'exécution et sa stabilité. Les
> internals (repositories, adapters, `http/`, `services/`, `admin/`)
> ne sont pas publics — aucun deep import n'est nécessaire ni possible.

Légende contexte : **build** = utilisé au build/`getStaticPaths`/config ;
**SSR** = runtime serveur ; **pur** = isomorphe, aucune dépendance.

## `@kreiz/core` (racine)

Intégration Astro — le point d'entrée unique.

| Symbole | Rôle | Contexte |
|---|---|---|
| `kreiz(config?)` | Intégration Astro : injecte toutes les routes, monte le module virtuel, injecte les redirections au build | build |
| `kreizConfigSchema` | Schéma Zod de la config (revalidation fail-fast) | build |
| `normalizeKreizConfig` | Applique les défauts (analytics privacy-safe, SEO résolu) | build |
| `KreizConfig`, `KreizConfigInput` | Types de la config résolue / acceptée | build |

```ts
// astro.config.ts
import { kreiz } from '@kreiz/core';
export default defineConfig({
  output: 'static',
  adapter: vercel(),
  integrations: [kreiz({ content: { types: [articleType] }, forms: [contactForm], seo: seoSite })],
});
```

**Stabilité : stable** (garde mécanique `tests/config.test.ts`,
`tests/admin-routes.test.ts`).

## `@kreiz/core/data`

Composition du schéma et connexion — ce dont le Project a besoin pour
*migrer*, pas pour lire les données Kreiz.

| Symbole | Rôle | Contexte |
|---|---|---|
| `defineCoreTables()` | Les 9 tables Kreiz à composer dans le schéma de l'app (`{...defineCoreTables(), maTable}`) | build/migrations |
| `CoreTables` | Type du dictionnaire | build |
| `createKreizDatabase` | Drizzle sur driver HTTP Neon (connexion à la 1re requête) | SSR/scripts |
| `kreizDatabaseEnvSchema`, `parseKreizDatabaseEnv` | Validation explicite de `KREIZ_DATABASE_URL` | SSR/scripts |
| `kreizContentStatuses`, `kreizMediaStatuses`, `kreizContactRequestStatuses`, `contactNotificationStatuses`, `kreizAnalyticsEventNames`, `kreizDeviceClasses` (+ types) | Vocabulaires fermés du schéma | partout |
| `KreizAdminUser`…`KreizRateLimit` (+ `*Insert`) | Types de lignes dérivés des tables — contrepartie typée de `defineCoreTables` | SSR |

```ts
// src/schema.ts (Project)
import { defineCoreTables } from '@kreiz/core/data';
export const coreTables = defineCoreTables();
export const schema = { ...coreTables, projectSettings };
```

**Stabilité : stable.** Les factories de repositories ont été retirées de
l'API publique en slice 10 : ce sont des internals.

## `@kreiz/core/content`

Déclaration des types de contenu et lecture des snapshots publiés.

| Symbole | Rôle | Contexte |
|---|---|---|
| `defineContentType` (+ types `ContentTypeDefinition`…) | Déclarer un type (clé, namespace, champs, template) | pur |
| `fields` (+ 13 types de descripteurs) | Vocabulaire borné des champs (text, textarea, select, url, date, metric, list, richText) | pur |
| `dataSchemaFromFields` | Schéma Zod dérivé des descripteurs | pur |
| `slugify`, `normalizeSlugInput`, `slugCandidates`, `resolveGeneratedSlug` | Règles de slug (utiles aux tests du Project) | pur |
| `resolveContentViewModel`, `ContentView` | Vue mutualisée preview/public (rich text déjà rendu en HTML contrôlé) | build/SSR |
| `collectRichTextMediaIds` | Références médias d'un contenu | pur |
| `createContentReader` | **Lecteur de build** : contenus publiés + couvertures résolues | build |

```ts
// src/pages/articles/[slug].astro
export async function getStaticPaths() {
  const reader = createContentReader({ databaseUrl, mediaPublicBaseUrl });
  const views = await reader.listPublishedViews({ declaration: articleType });
  return views.map((view) => ({ params: { slug: view.slug }, props: { view } }));
}
```

**Stabilité : stable.**

## `@kreiz/core/media`

Vues publiques des médias et helpers `<picture>`.

| Symbole | Rôle | Contexte |
|---|---|---|
| `resolvePublicMediaView`, `normalizeMediaPublicBaseUrl` | Ligne média → vue publique (base URL des variantes) | pur |
| `mediaSources`, `mediaFallbackSrc` | Sources responsive `<picture>` (le Project garde le layout) | rendu |
| `MEDIA_ACCEPTED_MIME_TYPES`, `MEDIA_MAX_UPLOAD_BYTES`, `MEDIA_VARIANT_WIDTHS`… | Bornes publiques du pipeline | partout |
| `KreizMediaError`, `MediaNotReadyError`, `MediaInUseError`… | Erreurs de domaine média | partout |
| `createContentReader` | Re-export de convenance (identique à `./content`) | build |

**Stabilité : stable.**

## `@kreiz/core/rich-text`

Format canonique Kreiz — JSON versionné, validé, rendu déterministe.

| Symbole | Rôle | Contexte |
|---|---|---|
| `KreizRichTextDocument` + types de nodes/marks | Le format document (version 1) | pur |
| `parseRichTextDocument`, `richTextValueSchema` | Validation stricte (bornes : taille, profondeur, protocoles) | pur |
| `renderRichTextDocument` | Renderer déterministe → HTML contrôlé (seule source légitime de `set:html`) | pur |
| `richTextDocumentFromPlainText`, `emptyRichTextDocument`, `isBlankRichTextDocument`, `coerceRichTextValue` | Conversions | pur |
| `extractRichTextMediaIds` | Références médias | pur |
| `isAllowedRichTextLinkHref`, `externalLinkAttributes` | Politique de liens | pur |

**Stabilité : stable.** Aucun type Tiptap n'est exposé — l'éditeur est un
détail d'implémentation du back-office.

## `@kreiz/core/forms`

Déclaration des formulaires et rendu public progressif.

| Symbole | Rôle | Contexte |
|---|---|---|
| `defineContactForm` (+ types) | Déclarer un formulaire (clé, champs, confirmation, notification) | pur |
| `formFields` (+ types) | Vocabulaire borné des champs de formulaire | pur |
| `renderContactFormHtml` | HTML public sans JS obligatoire (pour `set:html`) | build |
| `issueFormToken` | Jeton d'émission HMAC (le secret est passé en paramètre) | build/SSR |
| `publicFormSubmitPath`, `FORM_TOKEN_FIELD` | Chemin de l'endpoint public + champ du jeton | partout |

**Stabilité : stable.**

## `@kreiz/core/analytics`

Beacon et instrumentation côté Project.

| Symbole | Rôle | Contexte |
|---|---|---|
| `analyticsBeaconScript` | Tag `<script src>` à insérer dans les pages publiques | build |
| `beaconModuleSource` | Source pure du beacon (~2 Ko — tests de poids) | pur |
| `analyticsCtaAttributes`, `ANALYTICS_CTA_ATTRIBUTE` | Instrumentation CTA (`data-kz-cta`) | rendu |
| `KreizAnalyticsConfig` | Config résolue (défauts privacy-safe) | build |
| `ANALYTICS_BEACON_PATH`, `ANALYTICS_COLLECT_PATH` | Chemins canoniques | partout |

**Stabilité : stable.**

## `@kreiz/core/seo`

Déclaration et rendu SEO.

| Symbole | Rôle | Contexte |
|---|---|---|
| `defineSeoSiteConfig` | Déclarer la base canonique, le nom, l'organisation | build |
| `resolveContentSeo`, `resolvePageSeo` | Résolution déterministe (Project → contenu → overrides) | pur/build |
| `seoHeadTags` | Rendu head échappé | rendu |
| `websiteJsonLd`, `organizationJsonLd`, `articleJsonLd`, `breadcrumbJsonLd`, `jsonLdScriptTag` | Builders JSON-LD typés | rendu |
| `richTextDocumentToPlainText` | Repli description depuis un document riche | pur |
| `SITEMAP_PATH`, `ROBOTS_PATH` | Chemins canoniques | partout |

**Stabilité : stable.**

## `@kreiz/core/virtual`

Déclaration de `virtual:kreiz/config` (types uniquement) — consommé par le
Core lui-même ; le Project n'y accède jamais directement.

## CLI `kreiz`

```sh
pnpm --filter @kreiz/core exec kreiz admin:create          # premier admin (interactif ou --email/--name/--password)
pnpm --filter @kreiz/core exec kreiz admin:reset-password  # reset + révocation de toutes les sessions
```

Utilise `KREIZ_DATABASE_URL`, hache avec Argon2id via le service du Core.
**Stabilité : stable** (couvert par `tests/admin-cli.test.ts` et utilisé par
le global-setup E2E — preuve du chemin canonique).
