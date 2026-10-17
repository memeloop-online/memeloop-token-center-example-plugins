# Opt-in policy rewrite + development fixture provider

This installable `0.2` example keeps request rewriting **disabled by default**.
Installation alone leaves every request's model, account choice and body intact.
The optional provider is a controlled development fixture, with fixed request,
response and token usage. It does not perform real inference or implement a
real supplier integration.

## Tenant-scoped rewrite

Keep the global configuration at `{"enabled":false}`. Through the existing
Plugins configuration editor or version-fenced configuration API, explicitly
select an isolated test tenant and set its override to `{"enabled":true}`. Do
not omit `tenant_external_id` in an API write: that selects the global scope
for an authorized global administrator. Provider/route group membership does
not scope a traffic hook; a global opt-in would rewrite all inheriting tenants.

Enabled requests replace the entire body with the fixed `example-rewritten`
model and `rewritten by plugin` user message. Other fields, including streaming,
tools and token limits, are discarded. Both the original and rewritten models
still require normal host authorization. This example always allows at its own
policy hook; it does not implement a deny mode.

The manifest requires exactly one boolean field, `enabled`, and rejects unknown
fields. The host validates that schema and serializes the value with
`serde_json::to_string`. The WAT reads `config-json` from request-context's sixth
string (zero-based flattened parameter slots 10/11) and enables rewriting only
for the exact bytes `{"enabled":true}`. Any other representation, including
whitespace, missing fields or extra fields, returns allow with no changes. This
strict match deliberately keeps unrecognized configuration disabled; it is not
a general JSON parser.

To stop the example, write `{"enabled":false}` to the same tenant with its latest
`scope_version` and a fresh `Idempotency-Key`, or restore its saved prior value.
The current configuration API supports GET/PUT; false remains an explicit tenant
override. Check the effective configuration and synthetic requests on every
runtime after its bounded configuration cache expires. Removing the package
does not remove saved configuration: review it before reinstallation.

## Fixture provider only

The `example-oauth-http` provider advertises OpenAI/text only. Its fixed body is
an OpenAI chat completion, not a Responses, Anthropic or embedding response.
Create a dedicated test account and routes in the isolated tenant; set
`development_fixture:true` and point `base_url` only at a controlled fixture
service, for example through a dedicated Higress test route. Use a disposable
fixture credential marker, never a supplier API key or OAuth token. Setting
`development_fixture:true` is an explicit acknowledgement, not network isolation;
the host's normal network policy still applies.

The buffered-v1 `prepare` export always sends `POST /vendor/infer` with the
fixed `from-component` prompt and `vendor-model` model. The component receives
no account credential; the host injects it after preparation. The fixture must
return HTTP 200. The host supplies a canonical status-first response envelope;
the guest rejects every status other than exactly 200, including redirects,
instead of converting it into success. For HTTP 200 it deliberately ignores
the body and returns the fixed `normalized by component` chat response and
usage 7/3. Thus a successful fixture check demonstrates the ABI and credential
boundary, not response parsing or supplier correctness. Streaming is unsupported;
test its rejection with rewriting disabled so the original stream field survives.

The OAuth schemas/adapter illustrate declarative metadata only. All
`oauth.example.com` URLs are nonfunctional placeholders. Do not start that login
flow or send it credentials. A real OAuth adapter requires its own reviewed,
working endpoints and implementation; this package supplies neither.

## Build and acceptance

CI generates the checked-in `plugin.wasm` from the auditable `plugin.wat` using
`wasm-tools` 1.252.0. Run these steps in CI, not in a constrained workspace:

```sh
wasm-tools component embed wit/token-center.wit --world plugin \
  examples/plugins/policy-rewrite/plugin.wat \
  -o target/policy-rewrite.embedded.wasm
wasm-tools component new target/policy-rewrite.embedded.wasm \
  -o examples/plugins/policy-rewrite/plugin.wasm
wasm-tools validate --features component-model \
  examples/plugins/policy-rewrite/plugin.wasm
```

Acceptance must exercise default/false pass-through, exact true opt-in,
noncanonical direct-ABI configuration staying disabled, true followed by false
on the same component instance, tenant scope, original/final model authorization,
fixture HTTP 200, and non-200 normalization errors. Use the CI-built component;
do not edit Wasm bytes or accept WAT review as runtime verification.

The WAT requests no HTTP, KV or logging capability. The provider's outbound
request is executed by the host under the configured account's network policy.
