# Keitaro Wrap frontend

Local/trusted-environment SPA for the Slice 7 FastAPI wrapper. It does not implement
backend business rules, does not call Keitaro directly, and does not include auth or
deployment. Do not expose it publicly without a separate authentication and
access-control decision.

## Toolchain

- Bun **1.4.2** is the package manager and script runner only. Application code uses
  browser/standard JavaScript APIs; no `Bun.*` or `bun:*` runtime API is used.
- The version is pinned in `.bun-version` and mirrored in `package.json`.
- `bun.lock` is the committed text lockfile. Never hand-edit it.
- Vite + React + TypeScript, React Router, TanStack Query, CSS Modules + shared design
  tokens. No Tailwind, shadcn/ui, React Hook Form or Zod.

Lifecycle scripts are not trusted by default. `trustedDependencies` is empty because
installation and checks work without running dependency postinstall scripts. If a future
dependency genuinely requires one, add it explicitly with a documented reason; never
blanket-trust packages.

## Local setup

From this directory:

```bash
bun ci                 # frozen install from bun.lock
bun run generate:api   # regenerate types from the wrapper runtime OpenAPI
bun run dev            # Vite dev server with /api proxy to http://localhost:8000
```

Start the backend separately from the repository root:

```bash
uv run uvicorn app.main:app --reload
```

The dev proxy rewrites `/api/...` to the FastAPI root, so no CORS change is needed.
Override the target with `VITE_API_PROXY_TARGET` if the backend runs elsewhere.

## Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run build
bun run check          # all of the above
bun run test:e2e       # Playwright + axe smoke against the built app
```

`test:e2e` uses locally installed Google Chrome (`channel: "chrome"`) and starts
`vite preview` on `127.0.0.1:4173`. It mocks the wrapper API with Playwright routes;
no backend or Keitaro request is made. CI uses the pinned Bun version via
`oven-sh/setup-bun` and installs with `bun ci`.

## API contract source

`src/api/generated/openapi.ts` is generated from the **wrapper runtime OpenAPI**
(`app.openapi()` via `bun run generate:api`) and currently covers the S8-A–S8-C
schemas. `docs/openapi.json` in the repository root is the Keitaro Admin API snapshot
and is not a browser-facing contract.

## Routes

- `/campaigns/open` — manual campaign ID entry.
- `/campaigns/:campaignId` — cached streams and explicit Fetch.
- `/campaigns/:campaignId/streams/:streamRef` — offer editor: committed baseline,
  staged draft, local draft commands and latest publication status. Opening this
  route performs GET reads only; Fetch remains an explicit workspace action.
- `/recovery` — point-in-time bounded queue plus an explicit, confirmed recovery
  pass with local lock and GET-only unlock. Push and publication Cancel are not
  available.

## Operation UUID recovery

The creation URL (`/campaign-creations/{uuid}`) is authoritative and mirrors the id into
namespaced `sessionStorage`. The order is: check existing id → generate UUIDv4 only if
absent → persist to `sessionStorage` → navigate to the operation URL → POST with that
UUID. `OPERATION_NOT_FOUND` offers an explicit same-UUID retry; a new UUID requires an
explicit, confirmed new attempt. No live Keitaro write is performed by this frontend.
