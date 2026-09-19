# Kreiz

> Open-source editorial core for Astro

Kreiz is a reusable editorial core for building professional, admin-managed, editorial
and semi-static sites with Astro — without a page builder. It provides the editorial
engine; each project provides branding, content types, templates and wording.

> The back office manages content. The frontend controls presentation.

## What Kreiz is — and is not

**Is**: a batteries-included editorial engine — private admin, code-declared
content types, draft/publish model with frozen public snapshots, media
pipeline, rich text, contact forms, privacy-first analytics, SEO — that
compiles to a **static-first** public site (only the admin and small public
endpoints run on a server).

**Is not**: a page builder, a hosted CMS, a multi-role workflow tool, an
e-commerce or newsletter platform. No plugin marketplace, no theme system.
The Project owns its presentation, its schema and its migrations.

**Philosophy — static-first**: `Save ≠ Publish` is structural. The public
build reads only frozen `published_*` snapshots; publishing requests a
rebuild (deploy hook) and a failed rebuild never damages the served site.
The database is the source of truth; the static output is a projection.

## Architecture in one minute

- pnpm monorepo: [`packages/core`](packages/core) (`@kreiz/core`, the
  engine) and [`apps/demo`](apps/demo) (reference consumer — public API
  only, no hacks)
- The core ships an Astro integration: `kreiz()` injects the whole
  back-office (`/admin/*`, SSR, session-guarded, CSRF) and the only public
  endpoints (`/api/forms/[key]`, `/api/analytics/event`, prerendered
  beacon/sitemap/robots)
- Layered core: pure domain → services → ports (`ObjectStorage`,
  `ImageTransformer`, `BackgroundJobs`, `Mailer`, `RebuildTrigger`) →
  reference adapters (S3-compatible with in-house SigV4, Sharp, Vercel
  `waitUntil`, webhook mailer, deploy hook) → Drizzle/Neon data layer
- Content types, contact forms and SEO are **declared in code** by the
  Project; forms and admin UI are generated — validated server-side,
  rendered progressively (no required JavaScript)
- Full documentation: [`docs/architecture.md`](docs/architecture.md) — in
  particular the Save / Publish / Snapshot / Build model

## Capabilities

- **Admin**: email + Argon2id (OWASP), server-side revocable sessions
  (14-day sliding / 90-day absolute), login rate limiting, session-bound
  CSRF, append-only audit log, `kreiz` CLI for first admin and password
  resets
- **Content & publication**: generated CRUD, server-enforced route
  namespaces, slug handling, draft management, soft delete, SSR preview
  with the project's real templates; publishing freezes a public snapshot
  and requests a rebuild; published slug changes create automatic 301
  redirects (chain normalization, loop prevention) materialized at build
  time
- **Media**: direct presigned browser uploads to any S3-compatible
  storage (R2/MinIO/S3), server-side verification of the real object,
  async responsive variants (400–2000 px, WebP + AVIF, no upscaling,
  EXIF stripped), explicit lifecycle with retry/recovery, content covers
  with their own snapshot
- **Rich text**: canonical versioned JSON document, Tiptap admin editor
  behind a strict boundary, deterministic public renderer (never stored
  HTML), hostile-paste normalization
- **Forms**: progressive HTML (works without JavaScript), HMAC issuance
  token, honeypot, minimum fill time, PostgreSQL rate limiting,
  server-computed idempotency, persistence **before** notification,
  retry with backoff + admin re-send + recovery sweep
- **Analytics**: static ~2 KB beacon, no cookies, DNT/GPC respected, no
  IP stored, referrer reduced to domain, form conversions without form
  data, SQL dashboard, configurable retention (default 90 days)
- **SEO**: code-declared canonical base (never a `Host` header), resolved
  head (title/description/canonical/Open Graph/Twitter), typed JSON-LD,
  prerendered `sitemap.xml` and `robots.txt`, editorial `noindex`

## Quick start

```sh
pnpm install
pnpm build                       # core (dist/) then demo
cp apps/demo/.env.example apps/demo/.env    # set KREIZ_DATABASE_URL (Neon branch)
                                           # and KREIZ_SECRET (openssl rand -base64 32)
pnpm db:migrate                  # apply apps/demo migrations (app-owned chain)
pnpm --filter @kreiz/core exec kreiz admin:create   # first admin (interactive)
pnpm --filter @kreiz/demo dev    # http://127.0.0.1:4321 — admin at /admin
```

Building your own project from scratch: [`docs/build-a-project.md`](docs/build-a-project.md).
Configuration reference (every `KREIZ_*` variable, defaults, dev vs prod):
[`docs/configuration.md`](docs/configuration.md).

## Commands

```sh
pnpm build          # build core, then demo
pnpm typecheck      # tsc (core) + astro check (demo)
pnpm lint           # eslint
pnpm test           # vitest unit (integration skips without a database)
pnpm test:integration  # against $KREIZ_DATABASE_URL or $KREIZ_TEST_DATABASE_URL
pnpm test:e2e       # Playwright: per-slice critical paths + the global
                    # end-to-end journey (core-happy-path.spec.ts) and the
                    # recovery journey (core-recovery.spec.ts)
```

## Project vs Core

| Owned by the Project | Owned by the Core |
|---|---|
| content types, forms, SEO/analytics config | admin UI, APIs, guards, CSRF, audit |
| templates and public pages | publication snapshots, redirects engine |
| schema composition + migrations | repositories, services, ports/adapters |
| branding, wording, layout | rich text format + renderer, media pipeline |

The package boundary is mechanical: the `exports` map is the only public
surface (deep imports fail typecheck). See [`docs/api.md`](docs/api.md).

## Build & deploy

Astro `output: 'static'` + Vercel: the public site is prerendered (pages,
sitemap, robots, beacon); a single serverless function serves `/admin/*`
and the public collection endpoints. Publishing triggers a deploy-hook
rebuild; the Vercel output is verified in tests. Details:
[`docs/operations.md`](docs/operations.md) (recovery, retention, cron
expectations) and [`docs/production-readiness.md`](docs/production-readiness.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — layers, integration,
  the Save/Publish/Snapshot/Build model
- [`docs/api.md`](docs/api.md) — public API surface, subpath by subpath
- [`docs/configuration.md`](docs/configuration.md) — project config and
  environment variables reference
- [`docs/build-a-project.md`](docs/build-a-project.md) — build a real
  project without reading the core
- [`docs/operations.md`](docs/operations.md) — runbooks, recovery table,
  external cron needs
- [`docs/privacy-data-map.md`](docs/privacy-data-map.md) — per-table data
  map for privacy review
- [`docs/technical-debt.md`](docs/technical-debt.md) — honest debt register
- [`docs/production-readiness.md`](docs/production-readiness.md) —
  ready / conditional / not yet
- [`docs/handoff.md`](docs/handoff.md) — developer handoff, performance
  baseline, next step
- [`docs/cadrage.md`](docs/cadrage.md) — original vision and decision
  record · [`docs/slices/`](docs/slices) — per-slice verification logs

## Status

**Pre-release — closing pass complete, CONDITIONALLY READY.** Ten
development slices plus a security interlude are complete and verified
(unit, integration on real PostgreSQL/Neon, E2E including a global
end-to-end journey). The final adversarial security review has been
performed (GLM), followed by an independent senior review (Claude) —
neither found a new critical or high vulnerability; the findings that were
confirmed have been fixed in the working tree. Remaining production
conditions (contact-requests retention policy, external cron for
recoveries, Vercel-only IP trust, storage-derived CSP) are listed in
[`docs/security-review-final.md`](docs/security-review-final.md) and
[`docs/production-readiness.md`](docs/production-readiness.md).

Baseline: Node 24 LTS · Astro 7 · Tailwind 4 · Neon PostgreSQL + Drizzle ·
Vercel. Exact versions are locked in `pnpm-lock.yaml`.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
