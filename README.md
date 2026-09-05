# Kreiz

> Open-source editorial core for Astro

Kreiz is a reusable editorial core for building professional, admin-managed, editorial
and semi-static sites with Astro — without a page builder. It provides the editorial
engine; each project provides branding, content types, templates and wording.

> The back office manages content. The frontend controls presentation.

## Project status

**Early development / pre-release.** Kreiz is not ready for general production use yet.
The repository currently contains the slice 0 foundation (monorepo, tooling, CI and the
Astro integration spike) and the slice 1 data foundations (Neon/Drizzle schema owned by
the consuming app, server connection layer, first domain repositories). Features listed
in the roadmap below are planned, not shipped.

## Current architecture

- pnpm monorepo: [`packages/core`](packages/core) (`@kreiz/core`) and
  [`apps/demo`](apps/demo), a reference consumer of the package's public API only
- Astro 7, TypeScript strict, Tailwind CSS 4, Vue islands where interactivity earns its cost
- The core ships an Astro integration: admin and API routes are injected into the host app
  via `injectRoute()`
- Project → core configuration flows through a typed Vite virtual module,
  `virtual:kreiz/config`
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
pnpm db:generate                           # drizzle-kit generate from the composed schema
pnpm db:migrate                            # apply apps/demo migrations (Neon HTTP driver)
pnpm test:integration                      # against $KREIZ_DATABASE_URL (Neon) or
                                           # $KREIZ_TEST_DATABASE_URL (any real PostgreSQL)
```

Baseline: Node 24 LTS · Astro 7 · Tailwind 4 · Neon PostgreSQL + Drizzle.
Exact versions are locked in `pnpm-lock.yaml`.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).
