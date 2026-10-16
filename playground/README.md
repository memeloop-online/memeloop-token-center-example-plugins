# Text Model Playground

An optional MemeLoop Token Center plugin. It adds **Playground → Text models** and an **Open in playground** action beside each model route, using the host's React and Fluent UI components.

The signed-in operator can search enabled OpenAI and Anthropic text routes, select a model and an existing billing key, and send a temporary conversation. The host uses the current Operator credential and tenant; listing billing keys requires `keys:read`, and inference requires `keys:write` for the selected key. The key's normal model grants, limits, balance and billing apply. No new API key is created or exposed. Refresh discards the browser conversation; normal request and billing records remain.

Agent mode runs the pinned official MemeLoop browser orchestration script with a bounded adapter. It discovers the host API schema, may read allowed resources and asks for explicit confirmation before each change. Secret, credential and export routes are denied. Turn off product tools to try ordinary text chat, including models without tool support. Cancellation stops waiting and further loop iterations; an already accepted mutation cannot be rolled back, and an upstream request may continue to incur cost.

## Review package

The `verify playground package` GitHub Actions workflow creates `mtc-text-playground-1.0.0.tar.gz`, `SHA256SUMS` and `package-evidence.json`. The archive contains a complete plugin directory: manifest, one self-contained ESM asset, README and licenses. The evidence records the exact module digest and MemeLoop source revision. No CDN or relative module fetch is required.

Download the artifact from the pull request's Actions run and verify `sha256sum --check SHA256SUMS`. Extract the archive into a separate `mtc-text-playground` package directory. A development host configured to load that reviewed directory can inspect the two UI contributions. CI review artifacts are unsigned; production installation requires the administrator's normal signed OCI publication and trust policy. A source PR or review archive is not a signed production release.

The plugin requires a host supporting `operator.model-route.action`, navigation context, generic authenticated API discovery and operator inference. It does not work on older hosts lacking those contracts. The host controls scopes, active tenant and upstream routing for every request.

## Build

In CI, run `npm run build:playground`. It invokes pinned `esbuild@0.25.12`, bundles `playground/ui/playground.mjs` and the browser loop into one ESM file, rejects external imports and emits the review archive and digest evidence. Root health-intelligence build and publication remain independent.
