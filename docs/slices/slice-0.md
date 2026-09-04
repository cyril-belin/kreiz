# Slice 0 — Squelette, tooling, CI, spike d'intégration Astro

Statut : **terminé** · 2026-09-05

## Livré

- Monorepo pnpm : `packages/core` (`@kreiz/core`), `apps/demo` (`@kreiz/demo`), `docs/`.
- Tooling : TypeScript strict (`tsconfig.base.json`), ESLint 10 (flat config,
  typescript-eslint), Vitest 5, `.gitignore`, verrouillage `pnpm-lock.yaml`.
- CI à deux niveaux (`.github/workflows/ci.yml`) : `quality` (lint · build · typecheck ·
  test) toujours exécuté, y compris PR de forks ; job `integration` gated par la variable
  repo `RUN_INTEGRATION` — squelette en attente du slice 1 (branche Neon) et du slice 10
  (Playwright). Voir cadrage §17.
- `pnpm.onlyBuiltDependencies` : `esbuild`, `sharp` (binaire natif requis ; sharp servira
  au slice 5).

## Baseline verrouillée (lockfile)

| Outil | Version |
|---|---|
| Node | 24.18.0 |
| pnpm | 10.33.2 |
| Astro | 7.3.1 |
| @astrojs/vercel | 11.0.10 |
| TypeScript | 6.0.3 |
| Tailwind CSS | 4.3.3 (@tailwindcss/vite) |
| Zod | 4.5.4 |
| ESLint / typescript-eslint / Vitest | 10.10.0 / 8.69.0 / 5.0.0 |

Note : TypeScript 7.0.2 existe sur le registry mais `@astrojs/check` et typescript-eslint
ne le supportent pas encore (peer `^5 || ^6` et `<6.1.0`) → 6.0.3, dernière stable
supportée. Migration vers TS 7 quand l'écosystème l'aura intégré.

## Décision du spike : module virtuel pour la communication Core → config Project

**Choisi : module virtuel Vite `virtual:kreiz/config`**, fourni par l'intégration
(`updateConfig` + plugin Vite). Le code du Core (routes injectées, futur admin, future
preview) importe ce module typé (déclarations dans `src/virtual.d.ts`, exposées via
l'export public `@kreiz/core/virtual`).

Rejeté : registre global rempli à l'exécution de `astro.config` (effets de bord à
l'import, fragile avec la concurrence dev/build) ; codegen de fichiers (artefacts à
gérer). Le module virtuel est le mécanisme Astro/Vite natif, sans état, sérialisé dans le
bundle.

Sens de dépendance obtenu : Project → Core à l'installation, puis Core → configuration
Project uniquement via le module virtuel. Aucune dépendance inversée.

## Vérifications du spike (critères du cadrage §25)

1. `apps/demo` installe et configure l'intégration — `apps/demo/astro.config.ts`
   (`integrations: [kreiz({ spike: { … } })]`). ✅
2. Le Core injecte une route via son API publique — `injectRoute({ pattern:
   '/api/kreiz/spike', … })` dans le hook `astro:config:setup`. ✅
3. La route fonctionne en dev et au build avec l'adapter Vercel —
   dev : `GET /api/kreiz/spike` → `200` + JSON ; build : route SSR dans
   `.vercel/output/functions/_render.func/entry.mjs`, page d'accueil prérendue en
   `.vercel/output/static/index.html`. (Le test runtime sur le déploiement Vercel réel
   se fera à la mise en ligne du slice 4.) ✅
4. Config du projet accessible proprement à la route injectée — dev : la réponse contient
   `"spikeMessage": "config fournie par apps/demo"`. ✅
5. Aucun import profond nécessaire — le demo n'importe que `@kreiz/core` (racine). ✅
6. Import profond volontaire échoue au typecheck — sonde `@kreiz/core/dist/integration.js`
   → `error ts(2307): Cannot find module`, via la carte `exports` du package. Sonde
   supprimée après preuve. ✅

## État des vérifications

`pnpm lint` ✅ · `pnpm build` ✅ · `pnpm typecheck` (tsc + astro check, 0 erreur) ✅ ·
`pnpm test` 4/4 ✅

## Contenu délibérément minimal

Le schema de config ne contient que `spike` (`z.strictObject` : clé inconnue = erreur).
Les vraies sections (types de contenu, médias, rebuild…) arrivent avec leurs slices.
La route `/api/kreiz/spike` sera supprimée quand les vraies routes la remplaceront.
