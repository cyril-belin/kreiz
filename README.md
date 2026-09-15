# Kreiz

> Open-source editorial core for Astro

Kreiz is a reusable editorial core for building professional, admin-managed, editorial
and semi-static sites with Astro — without a page builder. It provides the editorial
engine; each project provides branding, content types, templates and wording.

> The back office manages content. The frontend controls presentation.

## Project status

**Early development / pre-release.** Kreiz is not ready for general production use yet.
The repository currently contains the slice 0 foundation (monorepo, tooling, CI and the
Astro integration), the slice 1 data foundations (Neon/Drizzle schema owned by the consuming
app, server connection layer, first domain repositories), the slice 2 admin authentication
layer (Argon2id credentials, revocable server-side sessions, guards, CSRF, login rate
limiting, append-only audit, the `kreiz` CLI and the `/admin` shell), the slice 3 content
engine (code-declared content types, generic admin CRUD with generated forms, slugs with
route namespaces, draft management, soft delete, content audit and SSR preview rendering the
project's real templates), the slice 4 publication layer (publish/unpublish with a frozen
"last public state", a platform-agnostic `RebuildTrigger` port with a Vercel deploy-hook
reference adapter, automatic 301 redirects on published slug changes with chain
normalization and loop prevention, build-time redirect materialization and a manual rebuild
action) and the slice 5 media pipeline (direct presigned browser uploads to any
S3-compatible object storage behind an `ObjectStorage` port, server-side verification of the
uploaded object, an explicit `uploading → processing → ready | failed` lifecycle, async
Sharp variants behind `ImageTransformer` and `BackgroundJobs` ports, a media library with
retry/recovery, content cover selection and public snapshotting, responsive
`<picture>` helpers). Features listed in the roadmap below that are not covered by these
slices are planned, not shipped.

## Current architecture

- pnpm monorepo: [`packages/core`](packages/core) (`@kreiz/core`) and
  [`apps/demo`](apps/demo), a reference consumer of the package's public API only
- Astro 7, TypeScript strict, Tailwind CSS 4, Vue islands where interactivity earns its cost
- The core ships an Astro integration: admin and API routes are injected into the host app
  via `injectRoute()` (`/admin/login`, `/admin`, `/admin/logout`, content CRUD under
  `/admin/content/*`, `/admin/preview/[id]` — all SSR, no admin plumbing is written by the
  consuming project)
- Authentication: email + Argon2id (OWASP parameters), server-side revocable sessions
  (raw token only in a hardened cookie, SHA-256 in the database), sliding 14-day expiry
  with a 90-day absolute cap, login rate limiting on PostgreSQL, session-bound CSRF,
  append-only audit log
- Content engine: content types declared in code by the project
  (`defineContentType()` from `@kreiz/core/content`), a bounded field vocabulary
  (text, textarea, select, url, date, metric, list), server-derived Zod validation of the
  `data` JSONB, generated admin forms (progressive HTML, no JS), server-enforced route
  namespaces, slug generation with collision handling, draft CRUD with soft delete,
  content audit events, and an authenticated SSR preview that renders the project's real
  templates — the same components the prerendered public pages use
- Publication: `Save != Publish` is enforced structurally — the public build only reads
  the frozen `published_*` snapshot columns, so saving never changes the public output.
  Publishing validates the current state, freezes it as the public version, audits and
  requests a rebuild through the `RebuildTrigger` port (Vercel deploy hook reference
  adapter, configured via the optional `KREIZ_REBUILD_DEPLOY_HOOK_URL` runtime env;
  HTTPS enforced in production, no adapter configured = explicit non-configured state).
  Rebuild failure never damages the served site: the database stays authoritative and the
  admin can retry from the dashboard or the edit screen. Published slug changes create
  automatic 301 redirects with write-time chain normalization and loop prevention,
  materialized at build time through Astro's native `redirects` config (verified in the
  real Vercel output)
- Media: direct presigned uploads — the browser sends the file straight to an
  S3-compatible object storage (R2/S3/MinIO) behind the `ObjectStorage` port (reference
  adapter with in-house AWS Signature V4, no provider SDK), while the server verifies the
  **real** object (size, magic bytes) before flipping `uploading → processing`. Variants
  (400/800/1400/2000 px, WebP + AVIF, no upscaling, EXIF stripped) are generated
  asynchronously via the `ImageTransformer` (Sharp reference adapter) and `BackgroundJobs`
  ports (`waitUntil` on Vercel, fire-and-forget in dev, recovery services for a future
  cron). Originals stay private; only variants are public and immutable
  (`Cache-Control: immutable`). Content covers are a system column with their own public
  snapshot (`published_cover_media_id` — Save != Publish holds for covers too), only
  `ready` media can be published, and the build reader resolves covers into a stable view
  model consumed by the project's templates (responsive `<picture>` helpers in
  `@kreiz/core/media`). Storage is configured via the `KREIZ_STORAGE_*` runtime env
  (optional, all-or-nothing; see `apps/demo/.env.example`)
- The `kreiz` CLI creates the first admin and resets passwords (`admin:create`,
  `admin:reset-password`)
- Project → core configuration flows through a typed Vite virtual module,
  `virtual:kreiz/config` (configuration data + statically imported template components)
- The package's public surface is enforced mechanically by its `exports` map — deep
  imports fail typecheck

## Roadmap

Planned foundations, in build order: Neon/Drizzle data layer · admin authentication ·
content engine (code-declared content types, drafts, publishing) · media pipeline ·
public forms · internal analytics · SEO. See the design doc for scope and rationale.

## Documentation

Project framing, architecture decisions and slice log live in [`docs/`](docs/):

- [`docs/cadrage.md`](docs/cadrage.md) — vision, scope, architecture and decision record
- [`docs/slices/`](docs/slices) — per-slice verification logs

## Development

```sh
pnpm install        # install
pnpm build          # build core, then demo (topological order)
pnpm typecheck      # tsc (core) + astro check (demo)
pnpm lint           # eslint
pnpm test           # vitest (unit; integration tests skip without a database)
```

Database (migrations live in `apps/demo` — the app owns them, not the core):

```sh
cp apps/demo/.env.example apps/demo/.env   # then set KREIZ_DATABASE_URL (Neon branch)
                                           # and KREIZ_SECRET (openssl rand -base64 32)
                                           # optionally KREIZ_REBUILD_DEPLOY_HOOK_URL
pnpm db:generate                           # drizzle-kit generate from the composed schema
pnpm db:migrate                            # apply apps/demo migrations (Neon HTTP driver)
pnpm test:integration                      # against $KREIZ_DATABASE_URL (Neon) or
                                           # $KREIZ_TEST_DATABASE_URL (any real PostgreSQL)
pnpm test:e2e                              # Playwright — admin critical paths (needs a DB)
```

Admin CLI (uses `KREIZ_DATABASE_URL`, hashes with Argon2id through the core's
own service):

```sh
pnpm --filter @kreiz/core build   # the CLI runs from dist/
pnpm --filter @kreiz/core exec kreiz admin:create          # interactive
pnpm --filter @kreiz/core exec kreiz admin:reset-password  # revokes all sessions
```

Baseline: Node 24 LTS · Astro 7 · Tailwind 4 · Neon PostgreSQL + Drizzle.
Exact versions are locked in `pnpm-lock.yaml`.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
