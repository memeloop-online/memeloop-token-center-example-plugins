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
