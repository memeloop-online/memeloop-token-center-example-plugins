# Text Model Playground

An optional MemeLoop Token Center plugin. It adds **Playground → Text models** and an **Open in playground** action beside each model route, using the host's React, Fluent UI and current theme.

The signed-in operator can choose an authorized tenant and model, adjust inference parameters and compare temporary chat sessions. Each model route carries its own reasoning level and system instruction. Browser state is ephemeral: refresh discards conversations. Inference uses the operator's existing session and tenant authority; no new API key is created or exposed.

Agent mode runs the pinned official MemeLoop browser orchestration script with a bounded adapter. It discovers the host API schema, may read allowed resources and asks for explicit confirmation before each change. Secret, credential and export routes are denied. Cancellation stops waiting and further loop iterations; an already accepted mutation cannot be rolled back.

## Review package

The `verify playground package` GitHub Actions workflow creates `mtc-text-playground-1.0.0.tar.gz`, `SHA256SUMS` and `package-evidence.json`. The archive contains a complete plugin directory: manifest, one self-contained ESM asset, README and licenses. The evidence records the exact module digest and MemeLoop source revision. No CDN or relative module fetch is required.

Download the artifact from the pull request's Actions run and verify `sha256sum --check SHA256SUMS`. Extract the archive into a separate `mtc-text-playground` package directory. A development host configured to load that reviewed directory can inspect the two UI contributions. CI review artifacts are unsigned; production installation requires the administrator's normal signed OCI publication and trust policy. A source PR or review archive is not a signed production release.

The plugin requires a host supporting `operator.model-route.action`, navigation context, generic authenticated API discovery and operator inference. It does not work on older hosts lacking those contracts. The host controls scopes, active tenant and upstream routing for every request.

## Build

In CI, run `npm run build:playground`. It invokes pinned `esbuild@0.25.12`, bundles `playground/ui/playground.mjs` and the browser loop into one ESM file, rejects external imports and emits the review archive and digest evidence. Root health-intelligence build and publication remain independent.
