# Health service-data runtime contract

The 1.2.1 manifest selects the real Rust Wasm component in `component/` through
`component_adapter`. The Node runtime remains a reference implementation and
Pages remains a separate public snapshot. The installed UI reads the host
service-data envelope.

## Configuration and authority

`createRuntimeCollector(config, authority, fetch)` is exported from the server
package. `config.sources` is required and nonempty, with no implicit three-source
registry. Each source declares ID, label, HTTPS page/data/robots URLs, exact data
path, observation lifetime, and one versioned normalizer: `codexradar_v1`,
`deepswe_v1`, or `aixhan_v1`. Unknown selectors fail closed.

Authority comes from the verified manifest, never browser or tenant input.
Plugin/endpoint identity is `mtc-health-intelligence` / `health-intelligence`.
Every configured origin must already be in the signed HTTP capability.
Configuration cannot grant network authority. Page, data and robots URLs share
an origin; credentials, queries, fragments and redirects are rejected. Robots
denial/unavailability blocks data collection.

The injected transport receives public GET requests, fixed Accept/User-Agent,
omitted credentials, and an abort signal. Operator tokens, tenant secrets,
provider credentials and OAuth state cannot enter configuration or headers.
DNS pinning and public-destination enforcement remain host responsibilities.

## Isolation, timeout and failure cache

Each collector owns its registry, in-flight work, last-good data and negative
cache. Recreate it on configuration/authority revision; never reuse it between
tenant-specific feeds. Public global source records contain no tenant data.
Host durable cache identity includes runtime revision, plugin ID, endpoint ID
and endpoint contract revision. Every API read checks `plugins:read`, endpoint
`metrics:read`, and the service tenant restriction before reading cache. API
responses are private/no-store; service credentials never travel upstream.

Runtime transport uses a 4000 ms per-request timeout, zero automatic retries,
and 1 MiB data body cap. Success caches for 300 seconds. Failure caches for 30
seconds, including forced reads; concurrent reads share work. Failure retains
last-good rows and original timestamps as stale. Without last-good data it
returns error/empty rows. Recovery clears negative cache. Private transport
exception text is discarded.

The UI verifies plugin/endpoint provenance and propagates host stale/unavailable
state even if embedded records say `ok`. Refresh reads cache; it does not execute
collection, bypass backoff or refresh successful collection timestamps.

The pinned host `4c3cb9acb06f86cfdcdfd319b1cfcf1cd924fbdc` omits
`provenance.freshness`. Its `partial`, `source` and millisecond `fetched_at`
fields remain supported: network/cache success displays its records, partial or
stale-cache results retain records as stale, and manifest fallback is unavailable.
Legacy collection times older than twenty minutes or beyond the existing clock
skew allowance downgrade to stale. Explicit modern freshness takes precedence
over this legacy inference; identity checks apply to both response shapes.

## Component ABI and release boundaries

The host already supports `memeloop:token-center@0.2.0`, world
`service-data-plugin`, with `service-data-v1.collect(collector-id, config-json)`
and `normalize(normalizer-id, config-json, collected-json)`. Manifest endpoint
`component_adapter` selects collector/normalizer/config. Host HTTP returns an envelope
with status, headers and `body_base64`. Collect and normalize share one host
execution deadline and body cap. No additional host API or SDK major is needed.

The component accepts only the exact approved configuration in
`component/sources.json`, also embedded in the signed manifest. HTTP uses fixed
fixed public GET/HEAD headers and no automatic retries. HEAD is restricted to the exact robots endpoints: successful HTML metadata and 404/410 skip the robots body, text robots use GET with the existing 65KiB limit, and HEAD 405/501 falls back to bounded GET. Other HEAD failures remain source errors. Robots and data requests for all
three sources and normalization share the host execution deadline; endpoint
`timeout_millis` is 30000, further bounded by the host execution timeout. Ordinary request, robots, JSON and normalization failures are isolated per source with a fixed error code, empty rows and unknown (empty) fetchedAt. Successful sources retain their actual HTTP Date and rows. All sources failing returns an error, preserving the host's durable last-good endpoint snapshot; Wasm traps also remain whole-call failures. Collection normalizes all input rows before ranking and truncating to 24, then emits a compact intermediate payload. Normalize validates its source order, dates, safe errors and canonical bounded rows before producing the unchanged public schema.

The WIT has no clock import. The component requires a valid upstream HTTP Date
for each successful data response and uses it for embedded `fetchedAt`; the
host envelope's `fetched_at` remains the authoritative collection time. Missing
Date fails closed. Upstream Date is not proof of local completion time. The UI
continues to evaluate source observation age and host freshness separately.

The existing verify workflow builds the actual component, executes it in
Wasmtime with the new service-data-only host budget of 100,000,000 shared fuel, 32 MiB memory and a shared 30000 ms
epoch/HTTP deadline. This package requires that new host budget; the previous 5,000,000-fuel host is not sufficient for the observed source sizes. Traffic plugin fuel remains unchanged in the host. Scenarios cover mixed-offset latest-observation ordering,
robots denial with zero data calls, malformed base64, missing Date, HTML, HTTP
status and redacted transport failures. CI compares normalized rows with the Node
reference, and checks WIT equality against the pinned host. The exact manifest, fallback
and component output are checked against authoritative host/installer schemas
using their pinned JSON Schema engine. These schema checks are not an official
signed-install receipt. Installer trust pins verified master artifact run
37914361285, source b1b0a01d2adcae6f94d7c51a228ff249a65cfdd3. The publish
workflow packages those Wasm bytes, signs the exact OCI digest, and reinstalls
with the official pinned installer on a GitHub Actions runner. Component build
and release evidence include the Wasm digest. No local build/install is needed.

A PR CI artifact is an unsigned review package. Signed publication requires the
existing master-only publish workflow after reviewed merge. That gate is not
executed by this PR. Fixture execution is not live three-source acceptance or
proof that all six HTTP requests fit the configured host deadline. Exact signed
artifact installation, live source collection, deadline suitability and cache
failure/recovery verification remain preproduction acceptance boundaries.
