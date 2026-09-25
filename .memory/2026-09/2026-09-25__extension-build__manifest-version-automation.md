---
id: 2026-09-25-extension-build-manifest-version-automation
task_key: extension-manifest-version-automation
title: Derive extension manifest version from the release tag at build time
date: 2026-09-25
status: completed
area: extension-build
tags:
  - extension
  - build
  - release
  - versioning
keywords:
  - manifest version
  - build.mjs
  - git tag
  - release workflow
  - VERSION env
---

## User Intent

The user loaded the released extension and saw version `0.1.4` even after a
`v0.1.5` release, i.e. the extension version never updated. They asked to
automate the version so it can never be forgotten, then re-release.

## Requirements and Constraints

- Single source for the extension version (release tag / env), not hardcoded
  in two manifests.
- Build must inject the version so a forgotten manual bump is impossible.
- Non-destructive re-release: do NOT move the existing `v0.1.5` tag.
- Keep CI green (server + extension tests, build).

## Decisions

- Version is resolved as `VERSION` env first, then the latest reachable
  `v*` git tag via `git describe --tags --abbrev=0`, then fallback `0.0.0`.
- Removed `"version"` from both source manifests (`manifest.chromium.json`,
  `manifest.firefox.json`) so the tag/env is the only source. Verified safe:
  `extension/tests/migration.test.mjs` asserts only `manifest_version`,
  background entrypoint, and permissions — never `version`. Source manifests
  are templates; only `dist/<target>/manifest.json` is loaded.
- Release workflow passes `VERSION: ${{ github.ref_name }}` to the build step
  so CI is deterministic and does not depend on tag discovery during checkout.
- Re-released as a new tag `v0.1.6` (the prior release `v0.1.5` shipped a
  manifest still reading `0.1.4`); `server/src/index.ts` version bumped
  `0.1.5` → `0.1.6` to stay in sync with the tag.

## Outcome

- New DI-testable module `extension/build-version.mjs` with `normalizeVersion`,
  `resolveVersion`, and `applyManifestVersion`.
- `extension/build.mjs` now derives the version and writes it into the
  distributed `manifest.json` instead of raw-copying the source manifest.
- Local `node build.mjs` now resolves `0.1.5` from the `v0.1.5` tag (previously
  hardcoded `0.1.4`), proving the automation works.
- Released `v0.1.6`; verified the downloaded chromium zip manifest is `0.1.6`.

## Files Changed

- `extension/build-version.mjs` — new pure version resolution/injection logic.
- `extension/build.mjs` — import the module, resolve version, inject into dist manifest.
- `extension/manifest.chromium.json`, `extension/manifest.firefox.json` — dropped hardcoded `version`.
- `extension/tests/build-version.test.mjs` — new TDD tests for the version logic.
- `server/src/index.ts` — server version bumped to `0.1.6`.
- `.github/workflows/release.yml` — `VERSION: ${{ github.ref_name }}` on the build step.
- `README.md` — test counts 63 → 66; note that manifest version is build-injected.

## Validation

- `node --test tests/*.test.mjs` — 66/66 pass (includes the new build-version tests).
- `cd server && npm test` — 30/30 pass.
- `node build.mjs` locally → dist manifest `0.1.5` (from `v0.1.5` tag).
- CI and Release workflows for `v0.1.6` both completed successfully.
- Downloaded `fastmcp-browser-extension-chromium.zip` from the release and
  confirmed its `manifest.json` version is `0.1.6`.

## Gotchas

- Extension tests run via `node --test tests/*.test.mjs` from `extension/`;
  there is no `package.json` there, so `npm test` fails in that directory.
- On a branch checkout with `fetch-depth: 1` and no reachable tag, the version
  falls back to `0.0.0`; that only affects CI build artifacts, never a tagged
  release, because the workflow sets `VERSION` explicitly.
- `git describe` picks the latest reachable tag, so a local build before the
  next tag reflects the previous release version.

## Next Steps

None required.
