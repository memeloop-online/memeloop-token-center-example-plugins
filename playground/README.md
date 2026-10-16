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

## Signed OCI production publication

After reviewing and merging the publication PR, a maintainer may manually run
**publish signed playground plugin** (`publish-playground.yml`) on `master`.
Pull requests never publish, sign, or deploy packages. Publication uses the same
reviewed installer image and Cosign version in `release/playground-installer-trust.json`.
Publication requires that file to contain a reviewed compatible digest,
source revision, verification run, and `status: ready`. The initial reviewed pin
uses installer source `80fde8bfb77e15f8fa70b55ba7ad4655e1406459`, image digest
`sha256:9006ecd8b35632cdf9159d3ede46704607884fcd529b98ff9eed1e759225a036`,
and patched Cosign `v3.1.3-mtc.4`, verified in the successful
[official source CI run](https://github.com/memeloop-online/memeloop-token-center/actions/runs/38839841258). The installer executable is trusted through this master-reviewed immutable image
digest and the official source CI evidence; image labels and version checks only
confirm compatibility, and do not establish executable trust by themselves.
The older health-plugin
installer pin does not understand `operator.model-route.action` and cannot be reused. It builds only the external UI plugin; no core image
is rebuilt. Registry publication needs the repository workflow's package-write
permission and GitHub OIDC authority.

The workflow publishes these exact trust coordinates:

| Setting | Value |
| --- | --- |
| Plugin ID | `mtc-text-playground` |
| Repository | `ghcr.io/memeloop-online/memeloop-token-center-text-playground-plugin` |
| Reference | Repository plus `@sha256:<digest>` from `plugin-release.json` |
| Signature policy | Cosign keyless |
| Certificate identity | `https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-playground.yml@refs/heads/master` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |

Do not trust the mutable `sha-<revision>` tag for installation. The release job
signs the immutable OCI digest, verifies the exact identity and issuer, and then
reinstalls the signed bytes with the pinned official MTC installer in an empty
plugin directory. It compares every installed file with the bundled package,
checks the OCI layer digests and install receipt, and emits `plugin-release.json`.
The `mtc-text-playground-release-<revision>` Actions artifact preserves that
reference, verification output, receipt, OCI manifest, source revision, bundled
module digest, licenses, and the reviewed installer trust record for 90 days.
The digest is available only after a successful publication; this source tree
intentionally contains no placeholder production digest.

The production administrator must review that evidence and configure the normal
plugin trust policy for the exact repository, certificate identity, and issuer.
Install the digest through the host's existing plugin installation/lifecycle
interface using that policy. GHCR read credentials may be needed if the package
is private. Do not disable signature checks or broaden the source allowlist.
The bundle contains `plugin.json`, `ui/playground.mjs`, README, LICENSE, and
THIRD_PARTY_NOTICES; `wasm` is null and no capabilities are requested.

For a command-line clean installation, use the already reviewed installer with
these arguments (supply the published immutable reference as `$PLUGIN_REFERENCE`):

```sh
install-plugin-oci "$PLUGIN_REFERENCE" \
  --plugin-dir /plugins \
  --allowed-source ghcr.io/memeloop-online/memeloop-token-center-text-playground-plugin \
  --cosign-certificate-identity https://github.com/memeloop-online/memeloop-token-center-example-plugins/.github/workflows/publish-playground.yml@refs/heads/master \
  --cosign-certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The current production host must already provide the discovery, inference, UI
module loading, and navigation contracts described above. After trusted hot
installation, enable the plugin using the host lifecycle interface and verify
both sidebar navigation and a model-route action, ordinary and agent text turns,
and billing on the selected existing key. Uninstall through that same lifecycle
interface and confirm the sidebar and model-route action disappear without a
core image rollout. This publication workflow changes no production trust,
activation state, or installed files; the production operator owns those steps.
