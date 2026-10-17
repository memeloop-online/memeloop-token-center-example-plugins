//! Copied only into the immutable, CI-verified MTC checkout by publish-examples.
//! Exercises the exact assembled packages through real host APIs, without a supplier.
use std::{collections::BTreeMap, fs, path::PathBuf};

use memeloop_token_center::{
    db::Database,
    plugin::{
        PluginRuntime, memeloop::token_center::types::RequestContext, validate_plugin_package,
    },
    provider::{OAuthFlowKind, ProviderCatalog, antigravity},
    schema::validate_instance,
};
use serde_json::{Value, json};

async fn runtime(id: &str) -> (tempfile::TempDir, PluginRuntime) {
    let source = PathBuf::from(std::env::var("MTC_EXAMPLE_PUBLICATION_ROOT").unwrap()).join(id);
    let manifest =
        validate_plugin_package(&source).expect("exact package passes real host validation");
    assert_eq!(manifest.id, id);
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("plugins");
    let package = root.join(id);
    fs::create_dir_all(&package).unwrap();
    fs::copy(source.join("plugin.json"), package.join("plugin.json")).unwrap();
    if manifest.wasm.is_some() {
        fs::copy(source.join("plugin.wasm"), package.join("plugin.wasm")).unwrap();
    }
    let database = Database::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("host.db").display()
    ))
    .await
    .unwrap();
    let runtime =
        PluginRuntime::load(root.to_str(), database).expect("load exact assembled package");
    (directory, runtime)
}

fn context() -> RequestContext {
    RequestContext {
        tenant_id: "publication-fixture-tenant".into(),
        principal_id: "publication-fixture-principal".into(),
        key_id: "publication-fixture-key".into(),
        protocol: "openai".into(),
        model: "requested-model".into(),
        config_json: "{}".into(),
    }
}

#[tokio::test]
async fn google_manifest_matches_real_host_catalog_schema_oauth_and_native_image_driver() {
    let (_directory, runtime) = runtime("google-antigravity").await;
    assert_eq!(runtime.manifests().len(), 1);
    assert!(runtime.manifests()[0].wasm.is_none());
    let mut catalog = ProviderCatalog::builtins();
    catalog.extend(runtime.provider_types()).unwrap();
    let provider = catalog
        .get(antigravity::DRIVER)
        .expect("contribution matches native driver ID");
    assert_eq!(provider.protocols, ["generation"]);
    assert_eq!(provider.modalities, ["image"]);
    let oauth = provider.oauth_adapter.as_ref().expect("OAuth contribution");
    assert_eq!(oauth.flow_kind, OAuthFlowKind::AuthorizationCodePkce);
    assert_eq!(
        oauth.login_url,
        "https://accounts.google.com/o/oauth2/v2/auth"
    );
    assert_eq!(oauth.poll_url, "https://oauth2.googleapis.com/token");
    assert_eq!(oauth.refresh_url, "https://oauth2.googleapis.com/token");
    let config = json!({
        "base_url": antigravity::BASE_URL,
        "control_url": antigravity::CONTROL_URL,
        "network_scope": "public", "project_id": "publication-fixture-project",
        "quota_read_policy": {"max_attempts": 3, "initial_delay_millis": 200, "total_timeout_millis": 20000}
    });
    validate_instance(&provider.config_schema, &config).unwrap();
    let native = antigravity::Config::from_account(&config).unwrap();
    assert_eq!(native.project_id, "publication-fixture-project");
    assert!(
        validate_instance(&provider.config_schema, &json!({"network_scope":"private"})).is_err()
    );
    validate_instance(
        &provider.credential_schema,
        &json!({"type":"oauth", "access_token":"fixture-only-not-a-token"}),
    )
    .unwrap();
    assert!(
        validate_instance(
            &provider.credential_schema,
            &json!({"type":"api_key", "value":"fixture-only"})
        )
        .is_err()
    );
    let envelope = antigravity::openai_image_request(
        "fixture-image-model",
        &native.project_id,
        &json!({"prompt":"fixture only; no network request", "n":1, "size":"1024x1024"}),
    )
    .unwrap();
    assert_eq!(envelope["model"], "fixture-image-model");
    assert_eq!(envelope["project"], native.project_id);
    assert_eq!(envelope["requestType"], "image_gen");
    assert!(
        antigravity::openai_image_request(
            "fixture-image-model",
            "publication-fixture-project",
            &json!({"prompt":"fixture", "n":2}),
        )
        .is_err()
    );
}

#[tokio::test]
async fn policy_exact_component_defaults_to_no_rewrite_and_preserves_upstream_errors() {
    let (_directory, runtime) = runtime("example-policy-rewrite").await;
    let manifest = &runtime.manifests()[0];
    let configuration = manifest.contributions.configuration.as_ref().unwrap();
    assert_eq!(configuration.default, json!({"enabled":false}));
    validate_instance(&configuration.schema, &json!({"enabled":true})).unwrap();
    assert!(validate_instance(&configuration.schema, &json!({"enabled":"true"})).is_err());
    let original = json!({"model":"requested-model", "messages":[]});
    let default = runtime.apply_traffic(context(), &original).unwrap();
    assert!(default.allow);
    assert!(default.model.is_none());
    assert!(default.request_json.is_none());
    assert!(default.upstream_account_id.is_none());
    for enabled in [true, false, true] {
        let decision = runtime
            .apply_traffic_with_config(
                context(),
                &original,
                &BTreeMap::from([("example-policy-rewrite".into(), json!({"enabled":enabled}))]),
            )
            .unwrap();
        assert!(decision.allow);
        assert!(decision.upstream_account_id.is_none());
        if enabled {
            assert_eq!(decision.model.as_deref(), Some("example-rewritten"));
            assert_eq!(
                decision.request_json.unwrap(),
                json!({"model":"example-rewritten", "messages":[{"role":"user", "content":"rewritten by plugin"}]})
            );
        } else {
            assert!(decision.model.is_none());
            assert!(decision.request_json.is_none());
        }
    }
    let providers = runtime.provider_types();
    let provider = &providers[0];
    assert_eq!(provider.id, "example-oauth-http");
    assert_eq!(provider.protocols, ["openai"]);
    assert_eq!(provider.modalities, ["text"]);
    let config = json!({"base_url":"https://fixture.invalid", "development_fixture":true});
    validate_instance(&provider.config_schema, &config).unwrap();
    assert!(
        validate_instance(
            &provider.config_schema,
            &json!({"base_url":"https://fixture.invalid"})
        )
        .is_err()
    );
    assert!(
        validate_instance(
            &provider.config_schema,
            &json!({"base_url":"https://fixture.invalid", "development_fixture":false})
        )
        .is_err()
    );
    let prepared = runtime
        .prepare_provider_request("example-oauth-http", context(), &config, &original)
        .unwrap()
        .unwrap();
    assert_eq!(prepared.method, reqwest::Method::POST);
    assert_eq!(prepared.path, "/vendor/infer");
    assert_eq!(
        serde_json::from_slice::<Value>(&prepared.body).unwrap(),
        json!({"prompt":"from-component", "model":"vendor-model"})
    );
    let headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
    let normalized = runtime
        .normalize_provider_response(
            "example-oauth-http",
            context(),
            200,
            &headers,
            b"{\"fixture\":true}",
        )
        .unwrap()
        .unwrap();
    assert_eq!(normalized.status, 200);
    assert_eq!(normalized.input_tokens, 7);
    assert_eq!(normalized.output_tokens, 3);
    assert_eq!(
        serde_json::from_slice::<Value>(&normalized.body).unwrap()["choices"][0]["message"]["content"],
        "normalized by component"
    );
    for status in [201, 207, 302, 400, 401, 403, 429, 500, 503] {
        assert!(
            runtime
                .normalize_provider_response(
                    "example-oauth-http",
                    context(),
                    status,
                    &headers,
                    b"{}"
                )
                .is_err(),
            "upstream status {status} must not become a successful response"
        );
    }
}

// Request size includes JSON escaping, not just the source string length. Every
// host invocation gets a fresh guest instance; large calls must not exhaust a
// previous invocation's bump allocator or alter a later tenant's small request.
#[tokio::test]
async fn policy_large_inputs_and_real_model_guard_chain() {
    let (directory, policy) = runtime("example-policy-rewrite").await;
    let guard = PathBuf::from(std::env::var("MTC_EXAMPLE_MODEL_GUARD_PACKAGE").unwrap());
    let root = directory.path().join("plugins");
    let package = root.join("mtc-model-guard");
    fs::create_dir_all(&package).unwrap();
    for name in ["plugin.json", "plugin.wasm"] {
        fs::copy(guard.join(name), package.join(name)).unwrap();
    }
    let database = Database::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("chain.db").display()
    ))
    .await
    .unwrap();
    let chain = PluginRuntime::load(root.to_str(), database).unwrap();
    assert_eq!(chain.manifests().len(), 2);
    let guard_config = BTreeMap::from([
        ("example-policy-rewrite".into(), json!({"enabled":false})),
        ("mtc-model-guard".into(), json!({"blocked_models":[]})),
    ]);
    for size in [64 * 1024, 256 * 1024, 1024 * 1024] {
        let request = json!({"model":"requested-model", "input":"\0\"\\".repeat(size / 3)});
        assert!(serde_json::to_vec(&request).unwrap().len() >= size);
        let disabled = policy.apply_traffic(context(), &request).unwrap();
        assert!(disabled.allow);
        assert!(disabled.model.is_none());
        assert!(disabled.request_json.is_none());
        let enabled = policy
            .apply_traffic_with_config(
                context(),
                &request,
                &BTreeMap::from([("example-policy-rewrite".into(), json!({"enabled":true}))]),
            )
            .unwrap();
        assert!(enabled.allow);
        assert_eq!(enabled.model.as_deref(), Some("example-rewritten"));
        assert_eq!(
            enabled.request_json.as_ref().unwrap(),
            &json!({"model":"example-rewritten", "messages":[{"role":"user", "content":"rewritten by plugin"}]})
        );
        let allowed = chain
            .apply_traffic_with_config(context(), &request, &guard_config)
            .unwrap();
        assert!(allowed.allow);
        assert!(allowed.request_json.is_none());
        let mut enabled_chain_config = guard_config.clone();
        enabled_chain_config.insert("example-policy-rewrite".into(), json!({"enabled":true}));
        let rewritten_chain = chain
            .apply_traffic_with_config(context(), &request, &enabled_chain_config)
            .unwrap();
        assert!(rewritten_chain.allow);
        assert_eq!(rewritten_chain.model.as_deref(), Some("example-rewritten"));
        assert_eq!(rewritten_chain.request_json, enabled.request_json);
        let mut blocked_config = guard_config.clone();
        blocked_config.insert(
            "mtc-model-guard".into(),
            json!({"blocked_models":["requested-model"]}),
        );
        let blocked = chain
            .apply_traffic_with_config(context(), &request, &blocked_config)
            .unwrap();
        assert!(!blocked.allow);
        // Public Debug contains only host-owned diagnostic fields; no guest
        // reason/body is retained. Check attribution without private access.
        let diagnostic = format!("{blocked:?}");
        assert!(diagnostic.contains("mtc-model-guard"));
        assert!(diagnostic.contains("policy_denied"));
    }
    // Stay below the explicit 16 MiB total-input contract being introduced in
    // the host: allow room for all context strings and the largest guard config.
    let near_limit =
        json!({"model":"requested-model", "input":"x".repeat(16 * 1024 * 1024 - 64 * 1024)});
    let mut large_config = guard_config.clone();
    large_config.insert(
        "mtc-model-guard".into(),
        json!({"blocked_models":
            (0..128).map(|index| format!("{index:03}{}", "x".repeat(253))).collect::<Vec<_>>()
        }),
    );
    assert!(
        chain
            .apply_traffic_with_config(context(), &near_limit, &large_config)
            .unwrap()
            .allow
    );
    let mut other_tenant = context();
    other_tenant.tenant_id = "independent-small-tenant".into();
    assert!(
        chain
            .apply_traffic_with_config(
                other_tenant,
                &json!({"model":"requested-model","messages":[]}),
                &guard_config
            )
            .unwrap()
            .allow
    );
}

// Reproduce the exact previously published component failure in CI on both
// immutable hosts. This is a synthetic package regression, not live attribution.
#[tokio::test]
async fn published_pre_growth_component_fails_large_default_off_input() {
    let (directory, fixed) = runtime("example-policy-rewrite").await;
    let root = directory.path().join("plugins");
    fs::copy(
        std::env::var("MTC_EXAMPLE_PRE_GROWTH_POLICY_COMPONENT").unwrap(),
        root.join("example-policy-rewrite/plugin.wasm"),
    )
    .unwrap();
    let database = Database::connect(&format!(
        "sqlite://{}?mode=rwc",
        directory.path().join("old.db").display()
    ))
    .await
    .unwrap();
    let before_growth = PluginRuntime::load(root.to_str(), database).unwrap();
    let request = json!({"model":"requested-model", "input":"x".repeat(64 * 1024)});
    let failure = before_growth
        .apply_traffic(context(), &request)
        .unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("plugin example-policy-rewrite execution failed")
    );
    let decision = fixed.apply_traffic(context(), &request).unwrap();
    assert!(decision.allow);
    assert!(decision.request_json.is_none());
    assert!(decision.model.is_none());

    use memeloop_token_center::plugin::lifecycle::{
        PluginGrant, RuntimeRevisions, manifest_digest,
    };
    let identities = before_growth.package_identities();
    let grants = before_growth
        .manifests()
        .into_iter()
        .map(|manifest| {
            let grant = PluginGrant {
                version: manifest.version.clone(),
                capabilities: manifest.capabilities.clone(),
                manifest_digest: manifest_digest(&manifest).unwrap(),
                identity: identities[&manifest.id].clone(),
            };
            (manifest.id, vec![grant])
        })
        .collect();
    let revisions = RuntimeRevisions::new(before_growth, grants).unwrap();
    let snapshot = revisions.pin().unwrap();
    for _ in 0..3 {
        let failed = snapshot
            .apply_traffic_with_config(context(), &request, &BTreeMap::new())
            .unwrap();
        assert!(!failed.allow);
        let diagnostic = format!("{failed:?}");
        assert!(diagnostic.contains("example-policy-rewrite"));
        assert!(diagnostic.contains("policy_execution_failed"));
    }
    let mut another_tenant = context();
    another_tenant.tenant_id = "small-independent-tenant".into();
    let small = json!({"model":"requested-model", "input":"small"});
    let blocked = snapshot
        .apply_traffic_with_config(another_tenant.clone(), &small, &BTreeMap::new())
        .unwrap();
    assert!(!blocked.allow);
    let diagnostic = format!("{blocked:?}");
    assert!(diagnostic.contains("example-policy-rewrite"));
    assert!(diagnostic.contains("policy_circuit_open"));
    assert!(fixed.apply_traffic(another_tenant, &small).unwrap().allow);
}
