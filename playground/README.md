# Text Model Playground

An optional MemeLoop Token Center plugin. It adds **Playground → Text models** and an **Open in playground** action beside each model route, using the host's React and Fluent UI controls, with the official `@memeloop/react-ui` Thread and Composer for chat.

The signed-in operator can search enabled OpenAI, Responses and Anthropic routes, select a model and an existing billing key, and chat or generate images. The host uses the current Operator credential and tenant; listing billing keys requires `keys:read`, and inference requires `keys:write` for the selected key. The key's normal model grants, limits, balance and billing apply. Requests use the core inference bridge and its routing, request archive, session indexing, usage analysis and billing. The plugin keeps only the current page's conversation in React memory; the core owns durable request and response records.

Agent mode runs the pinned official MemeLoop browser orchestration script with a bounded adapter. It discovers the host API schema, may read allowed resources and asks for explicit confirmation before each change. Secret, credential and export routes are denied. Turn off product tools to try ordinary text chat, including models without tool support. Cancellation stops waiting and further loop iterations; an already accepted mutation cannot be rolled back, and an upstream request may continue to incur cost.

Image generation uses `/internal/v1/inference/responses` with the selected outer model and the Responses tool `{ "type": "image_generation", "model": "gpt-image-2" }`, matching the proxy-imagegen protocol. The core accepts `stream: false` and handles upstream transport and final JSON assembly; `store: false` controls provider-side Responses storage. Core request, response-text, usage and session records follow the existing archive policy, which removes image payloads including `image_generation_call.result`. Generated image bytes remain in the current page's memory and are available through its download action; the plugin does not promise durable Base64 image storage. The page displays completed PNG/JPEG raster results, alongside any final assistant text. Partial image previews are not treated as completed images. Product API tools use native Responses function calls and outputs, including the same permission checks and per-change confirmation as chat.

The adapter exposes `protocol: 'openai' | 'anthropic' | 'responses'`, `enableImageGeneration` (default `false`), and `imageModel` (currently `gpt-image-2`). Enabling image generation on an OpenAI route selects the core Responses bridge. Assistant display messages and events may include `images: [{ dataUrl, mimeType }]`. Responses requests include `reasoning.encrypted_content` so stateless providers return opaque reasoning for native tool continuation. Image bytes and private reasoning are omitted from tool-result events; opaque Responses reasoning is replayed privately within the active tool loop. Refreshing the page clears the display memory, while the existing core request and session pages provide archived records under the core retention policy.

`conversationId`, `turnId` and `parentTurnId` attach the page's conversation to the core session index. They are sent as the inference bridge's `conversation: { id, turn_id, parent_turn_id }` wrapper, separately from provider request JSON. Each internal model round gets its own turn ID and links to the previous round; `lastTurnId` in the result lets the next user turn continue that chain. The UI keeps these identifiers in memory and starts a fresh conversation when cleared or when the tenant or billing key changes. No chat database, browser storage or separate archive is introduced by the plugin.

## Review package

The `verify playground package` GitHub Actions workflow creates `mtc-text-playground-1.1.0.tar.gz`, `SHA256SUMS` and `package-evidence.json`. The archive contains a complete plugin directory: manifest, one self-contained ESM asset, README and licenses. The evidence records the exact module digest and MemeLoop source revision. No CDN or relative module fetch is required.

Download the artifact from the pull request's Actions run and verify `sha256sum --check SHA256SUMS`. Extract the archive into a separate `mtc-text-playground` package directory. A development host configured to load that reviewed directory can inspect the two UI contributions. CI review artifacts are unsigned; production installation requires the administrator's normal signed OCI publication and trust policy. A source PR or review archive is not a signed production release.

Version 1.1.0 requires the host's `ReactDOM` and `ReactJSXRuntime` activation bindings, the new `/internal/v1/inference/responses` endpoint and `conversation: { id, turn_id, parent_turn_id }` inference wrapper, in addition to `operator.model-route.action`, navigation context and generic authenticated API discovery. Deploy the core version providing both inference contracts before installing this plugin version; the UI sends conversation wrappers on Chat and Messages requests as well as Responses. The host controls scopes, active tenant and upstream routing for every request.

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
