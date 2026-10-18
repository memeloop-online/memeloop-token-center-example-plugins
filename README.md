# MTC Example Plugins

Example plugins for [MemeLoop Token Center](https://github.com/memeloop-online/memeloop-token-center).

- [Text Model Playground](playground): ephemeral operator chat and the pinned official MemeLoop agent loop; CI produces a self-contained review package.
- [Rust guest sources](plugin-sources): model-guard, preferred-account, soonest-reset.
- [Provider manifests](plugins), including google-antigravity.
- [Policy rewrite component](examples/plugins/policy-rewrite), with reviewed WAT and Wasm.
- Health intelligence remains at the repository root; its existing build and release commands are preserved below.

Guest crates are standalone Cargo workspaces. Build and validate them in CI. Host integration tests check out this repository at an immutable revision; update that revision explicitly when accepting a new example release. Existing OCI package names remain stable; future signatures identify this renamed repository. Historical releases keep their original signing identity.

# MTC Model Health & Intelligence

[中文](docs/zh-CN/README.md)

A signed MemeLoop Token Center plugin that brings public model health and benchmark feeds into the Operator's Monitoring section.

The included sources are [Codex Radar](https://codexradar.com/), [DeepSWE](https://deepswe.datacurve.ai/), and [CDK Model Health](https://cdk.aixhan.com/model-health). Each source shows its observation time, collection time, status, and normalized results.

## Install

Use the OCI reference from the [latest GitHub Release](https://github.com/memeloop-online/memeloop-token-center-example-plugins/releases). MTC's official installer verifies its signature and installs the UI module and manifest together. The `component_v1` interface uses the host's React, Fluent components, and theme tokens. Chinese and English follow the operator locale.

Requires MTC's signed `component_v1` runtime. The exact tested host and installer are listed in [release/installer-trust.json](release/installer-trust.json).

## Data API

[Public snapshot](https://memeloop-online.github.io/memeloop-token-center-example-plugins/api/health-intelligence.json) · [JSON Schema](schemas-health-intelligence.json)

The installed component collects the three approved public JSON feeds through the MTC worker and host HTTP capability. Pages also publishes a reference snapshot every ten minutes. Each snapshot contains an open `sources` list. Source entries have `id`, `label`, `pageUrl`, `endpoint`, `fetchedAt`, `sourceUpdatedAt`, `maxObservationAgeSeconds`, `status`, and flat scalar `rows`.

The view calculates freshness from absolute timestamps every thirty seconds. Fetches older than twenty minutes appear as stale; each source also defines its observation lifetime. Collection failures retain the last successful records with a stale status.

## Add a source

For the Node reference, add one definition to [src/server/sources.ts](src/server/sources.ts): a stable ID, label, HTTPS page/data/robots URLs, observation lifetime, and normalizer. `createSourceRegistry` validates unique IDs and matching origins. Custom deployments can pass a source list to `SnapshotService`.

The installed component accepts only the exact signed three-source configuration in `component/sources.json`. Adding a runtime source requires updating its approved configuration, Rust normalizer, manifest capability and fixtures, then building and signing a new release.

The schema and UI accept new source IDs and flat scalar row fields. Existing benchmark fields have localized labels and number formats; additional fields display their declared names. Supply focused payload fixtures alongside a new normalizer.

## Run and publish

The [service-data runtime contract](docs/service-data-runtime.md) describes the
configuration-driven collector API, authority boundary, failure cache and the
actual WIT component, signed source configuration, host deadline and durable cache.

CI installs the npm lockfile, runs type checking and fixture tests, builds the Wasm component, executes collect/normalize in Wasmtime, and checks fixture parity and the exact pinned host WIT. The `publish plugin` workflow builds the actual component, collects a separate Pages reference snapshot, signs the OCI package containing `plugin.wasm`, and verifies an installation with the official MTC installer. GitHub Release archives reuse those package and snapshot bytes and include checksums and signature evidence.

The same collector supports a Node service through `npm run serve`, exposing `GET /api/health-intelligence`. Source fetches have a four-second timeout, two retries, and a five-minute memory cache.

Licensed under [Apache License 2.0](LICENSE).

### Install from a GitHub Release URL

Each reviewed `workflow_dispatch` publication on protected `master` publishes a
GitHub Release containing `<plugin-id>.json`. Copy that asset's
`https://github.com/memeloop-online/memeloop-token-center-example-plugins/releases/download/<tag>/<plugin-id>.json`
URL into the token center's plugin installation page. The descriptor contains
only format version 1, an immutable OCI digest reference, and the exact keyless
signer issuer/identity. The host still verifies its own source policy and Cosign
signature; a descriptor cannot authorize itself.

Publish `publish.yml` for `mtc-health-intelligence`, `publish-playground.yml` for
`mtc-text-playground`, and `publish-examples.yml` for `mtc-model-guard`,
`mtc-preferred-account`, `mtc-soonest-reset`, `google-antigravity`, and
`example-policy-rewrite`. All seven descriptors are actual Release assets,
created after the official installer's clean-install verification. Tags include
the plugin ID, full source revision, run ID and attempt. Assets and tags are never
replaced; use the exact download URL from the successful run summary. The
repository's shared latest release is intentionally not used for selecting a
plugin. Publication does not activate any production plugin.
