# Construire un Project Kreiz

> Guide du développeur (slice 10) : créer un vrai site avec Kreiz sans lire le
> code du Core. Kreiz est un **starter** : un nouveau projet part d'une copie
> de ce repository (template GitHub), pas d'un paquet à installer sur npm.
> `apps/demo` est une référence complète et consommée exclusivement par
> l'API publique — aucun hack.

## 1. Partir du template

Sur GitHub, depuis `cyril-belin/kreiz` : **Use this template** → votre repo
(ex. `mon-site`), puis :

```sh
git clone git@github.com:vous/mon-site.git
cd mon-site
pnpm install                       # Node 24 LTS
pnpm build                         # core (dist/) puis démo
```

Prérequis : un PostgreSQL (Neon recommandé), optionnellement un stockage
S3-compatible (R2/MinIO) pour les médias et un relais email pour les
notifications de contact.

Votre site vit comme `apps/<votre-app>`. Le plus court chemin est de partir
de la démo — une app complète et fonctionnelle — et de l'adapter :

```sh
cp -R apps/demo apps/mon-site
rm -rf apps/mon-site/node_modules apps/mon-site/dist apps/mon-site/.astro apps/mon-site/.vercel apps/mon-site/test-results
pnpm install
```

Puis trois ajustements :

- **Nom du paquet** : `"name": "@kreiz/demo"` → le vôtre dans
  `apps/mon-site/package.json`.
- **Scripts root** : `db:generate`, `db:migrate` et `test:e2e` ciblent
  `@kreiz/demo` — dupliquez-les pour votre app
  (ex. `pnpm --filter @kreiz/mon-site db:migrate`).
- **Gardez `apps/demo`** comme référence de travail tant que vous en avez
  besoin ; supprimez-la quand vous voulez (ajustez alors les filtres
  `@kreiz/demo` du workflow CI, qui pilote aussi l'E2E de la démo).

L'environnement de votre app : copier `apps/mon-site/.env.example` en
`.env` (ignoré par git) avec votre branche Neon et votre secret.

## 2. Schéma et migrations

Le schéma appartient à **votre app** — le Core ne possède aucune
migration. La copie de la démo apporte déjà la composition de référence :

```ts
// src/schema.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { defineCoreTables } from '@kreiz/core/data';

export const coreTables = defineCoreTables();       // 9 tables kreiz_*
export const projectSettings = pgTable('project_settings', { /* … */ });
export const schema = { ...coreTables, projectSettings };
```

```ts
// drizzle.config.ts
export default defineConfig({
  schema: './src/schema.ts', out: './drizzle', dialect: 'postgresql',
  dbCredentials: { url: process.env.KREIZ_DATABASE_URL ?? '' },
});
```

```sh
pnpm --filter @kreiz/mon-site db:generate   # votre chaîne de migrations
pnpm --filter @kreiz/mon-site db:migrate    # application sur votre base
```

## 3. Configuration

```ts
// astro.config.ts
import { kreiz } from '@kreiz/core';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',          // static-first : le public est prérendu
  adapter: vercel(),
  integrations: [kreiz({
    content: { types: [articleType] },
    forms: [contactForm],
    seo: seoSite,
  })],
});
```

Toutes les routes admin/API sont injectées — vous n'écrivez aucune
plomberie. Voir [configuration.md](configuration.md) pour chaque section
et les variables d'environnement.

## 4. Types de contenu

```ts
// src/content-types/article.ts
import { defineContentType, fields } from '@kreiz/core/content';

export const articleType = defineContentType({
  key: 'article',
  label: 'Article',
  labelPlural: 'Articles',
  routeNamespace: 'articles',          // → /articles/<slug>
  fields: {
    excerpt: fields.text({ label: 'Accroche', required: true, maxLength: 300 }),
    body: fields.richText({ label: 'Corps', required: true }),
    author: fields.text({ label: 'Auteur', required: true, maxLength: 120 }),
  },
  template: 'src/templates/ArticleContent.astro',
});
```

Le vocabulaire V1 des champs : `text`, `textarea`, `select`, `url`,
`date`, `metric`, `list`, `richText`. Les formulaires admin, la validation
serveur et la preview sont générés à partir de cette déclaration.

## 5. Templates et pages publiques

Un **même template** sert au public et à la preview admin :

```astro
---
// src/templates/ArticleContent.astro
import type { ContentView } from '@kreiz/core/content';
interface Props { view: ContentView<ArticleData> }
const { view } = Astro.props;
---
<h1>{view.title}</h1>
{view.cover && <CoverPicture view={view.cover} />}
<Fragment set:html={view.richText.body?.html} />   {/* HTML contrôlé par le Core */}
```

```astro
---
// src/pages/articles/[slug].astro — prérendu
import { createContentReader } from '@kreiz/core/content';
export const prerender = true;
export async function getStaticPaths() {
  const databaseUrl = process.env.KREIZ_DATABASE_URL;
  if (!databaseUrl) return [];                        // build sans base : 0 page, pas d'échec
  const reader = createContentReader({
    databaseUrl,
    mediaPublicBaseUrl: process.env.KREIZ_STORAGE_PUBLIC_BASE_URL ?? null,
  });
  const views = await reader.listPublishedViews({ declaration: articleType });
  return views.map((view) => ({ params: { slug: view.slug }, props: { view } }));
}
const { view } = Astro.props;
---
<ArticleContent view={view} />
<Fragment set:html={analyticsBeaconScript()} />
```

Important : le build ne lit **que** les snapshots publiés — le rendu
`view.richText.*.html` vient du renderer déterministe du Core (jamais de
HTML stocké).

## 6. Médias

Rien à écrire. La médiathèque (`/admin/media`) gère l'upload direct vers
votre stockage (presign), la vérification serveur, les variantes
responsive. Dans vos templates, `view.cover` est une vue publique
(`mediaSources()` / `mediaFallbackSrc()` de `@kreiz/core/media` pour le
`<picture>`), et l'éditeur riche insère des références média — jamais des
URLs.

## 7. Formulaires

```ts
// src/forms/contact.ts
import { defineContactForm, formFields } from '@kreiz/core/forms';

export const contactForm = defineContactForm({
  key: 'contact',
  label: 'Contact',
  confirmationPath: '/contact/merci',
  fields: {
    name: formFields.name({ label: 'Nom', required: true }),
    email: formFields.email({ label: 'Email', required: true }),
    subject: formFields.select({
      label: 'Sujet', required: true,
      choices: [{ value: 'question', label: 'Question' }, /* … */],
    }),
    message: formFields.message({ label: 'Message', required: true, minLength: 20 }),
    consent: formFields.consent({ label: "J'accepte d'être recontacté." }),
  },
  notification: {
    recipients: ['bonjour@mon-site.fr'],      // enveloppe exclusivement déclarée
    subject: 'Nouveau message — mon site',
    replyToField: 'email',
  },
});
```

```astro
---
// src/pages/contact.astro — page STATIQUE
const token = issueFormToken({ formKey: contactForm.key, secret });
---
<Fragment set:html={renderContactFormHtml(contactForm, { token })} />
```

La soumission (`/api/forms/contact`) est injectée par le Core :
anti-spam en couches, idempotence, persistance avant notification — la
page publique reste sans JavaScript obligatoire.

## 8. Analytics et SEO

- insérez `analyticsBeaconScript()` dans chaque page publique mesurée ;
  la collecte, le dashboard (`/admin/analytics`) et la rétention sont au
  Core ;
- déclarez la base canonique (`defineSeoSiteConfig`) et rendez la head
  avec `seoHeadTags(resolveContentSeo(...))` + JSON-LD builders — voir
  `apps/demo/src/templates/ArticleContent.astro` pour le modèle complet ;
- `sitemap.xml` et `robots.txt` sont générés par le Core (prérendus).

## 9. Premier admin et exploitation

```sh
pnpm --filter @kreiz/mon-site exec kreiz admin:create --email vous@site.fr --name Vous
```

Déploiement Vercel : variables de production (voir
[configuration.md](configuration.md) §2), deploy hook pour le rebuild,
`KREIZ_SECRET` présent au build **et** au runtime. Le cycle opérationnel
(publications, recovery, rétention) est décrit dans
[operations.md](operations.md).

## 10. Checklist du Project

- [ ] site créé depuis le template GitHub (repo dédié)
- [ ] app `apps/<votre-app>` partie de la démo, paquet renommé
- [ ] scripts root (`db:*`, `test:e2e`) et filtres CI ajustés à votre app
- [ ] `KREIZ_DATABASE_URL` (branche dédiée) + `KREIZ_SECRET` (build et runtime)
- [ ] chaîne de migrations appliquée sur votre base
- [ ] types de contenu + templates partagés public/preview
- [ ] pages `getStaticPaths` lisant `createContentReader`
- [ ] SEO : base canonique déclarée, head résolue, JSON-LD
- [ ] beacon analytics inséré dans les pages publiques
- [ ] groupes optionnels cohérents (storage, mail, rebuild hook)
- [ ] premier admin créé par le CLI
