use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime::component::{Component, HasSelf, Linker};
wasmtime::component::bindgen!({ path: "../wit", world: "service-data-plugin" });
const FUEL: u64 = 100_000_000;
const MEMORY: usize = 32 * 1024 * 1024;
const BODY_LIMIT: usize = 1_048_576;
const TIMEOUT: Duration = Duration::from_millis(30000);
const EPOCH_TICK: Duration = Duration::from_millis(10);
struct State {
    mode: &'static str, calls: usize, data_calls: usize, robots_gets: usize, robots: &'static str,
    limits: StoreLimits, deadline: Instant,
}
impl memeloop::token_center::host::Host for State {
    fn log(&mut self, _: String, _: String) {}
    fn kv_get(&mut self, _: String) -> Result<Option<Vec<u8>>, String> { Err("unexpected KV".into()) }
    fn kv_put(&mut self, _: String, _: Vec<u8>) -> Result<(), String> { Err("unexpected KV".into()) }
    fn http_request(&mut self, method: String, url: String, headers: String, body: Vec<u8>) -> Result<Vec<u8>, String> {
        if Instant::now() >= self.deadline { return Err("plugin execution deadline exceeded".into()); }
        self.calls += 1;
        assert!(method == "HEAD" || method == "GET");
        assert!(body.is_empty());
        let headers: Value = serde_json::from_str(&headers).unwrap();
        assert_eq!(headers.as_object().unwrap().len(), 2);
        assert_eq!(headers["user-agent"], "mtc-health-intelligence/1.2.1 (public-readonly)");
        let config: Value = serde_json::from_str(include_str!("../../component/sources.json")).unwrap();
        let source = config["sources"].as_array().unwrap().iter()
            .find(|s| s["endpoint"] == url || s["robotsUrl"] == url).expect("exact approved URL");
        let robots = source["robotsUrl"] == url;
        assert_eq!(headers["accept"], if robots { "text/plain" } else { "application/json" });
        assert!(robots || method == "GET", "HEAD is only for exact robots endpoints");
        if robots && method == "GET" { self.robots_gets += 1; }
        if !robots { self.data_calls += 1; }
        if robots && method == "HEAD" && self.mode == "head_network" { return Err("private transport exception".into()); }
        if !robots && self.mode == "network" { return Err("private transport exception".into()); }
        let mut bytes = if robots { if self.mode == "robots_denied_one" && source["source"] == "codexradar" {b"User-agent: *\nDisallow: /\n".to_vec()} else {self.robots.as_bytes().to_vec()} }
            else { std::fs::read(format!("test/fixtures/{}.json", source["source"].as_str().unwrap())).unwrap() };
        if !robots && self.mode == "mixed" && source["source"] == "aixhan" {
            bytes = serde_json::to_vec(&json!({"providerTimelines":[
                {"latest":{"id":"mixed-one","name":"older","status":"error","checkedAt":"2026-09-07T15:00:00+08:00"},
                 "items":[{"id":"mixed-one","name":"earlier-tie","status":"error","checkedAt":"2026-09-07T08:00:00Z"},
                          {"id":"mixed-one","name":"newer","status":"operational","checkedAt":"2026-09-07T16:00:00+08:00"}]},
                {"items":[{"id":"mixed-two","name":"second","status":"degraded","checkedAt":"2026-09-07T08:30:00Z"}]}
            ]})).unwrap();
        }
        if robots && method == "GET" && matches!(self.mode, "robots_html_large" | "robots_text_large") {
            bytes = vec![b'x'; if self.mode == "robots_html_large" {916_003} else {65_537}];
        }
        if !robots && matches!(self.mode, "public_sizes" | "near_cap") {
            bytes = public_size_fixture(source["source"].as_str().unwrap(), bytes, self.mode == "near_cap");
        }
        if !robots && self.mode == "body_cap" && source["source"] == "codexradar" { return Err("response body limit".into()); }
        if !robots && self.mode == "best_after_24" && source["source"] == "codexradar" {
            let mut value: Value = serde_json::from_slice(&bytes).unwrap();
            let mut row = value["comprehensive_points"][0].clone();
            let mut points = vec![row.clone(); 30];
            row["model"] = json!("last-best"); row["iq"] = json!(200);
            points.push(row); value["comprehensive_points"] = json!(points);
            bytes = serde_json::to_vec(&value).unwrap();
        }
        if !robots && source["source"] == "codexradar" && self.mode == "partial_json" { bytes = b"not-json".to_vec(); }
        if !robots && source["source"] == "codexradar" && self.mode == "partial_shape" { bytes = b"{}".to_vec(); }
        let content_length = bytes.len();
        if method == "HEAD" { bytes.clear(); }
        assert!(bytes.len() <= BODY_LIMIT, "same host response body cap");
        let mut envelope = json!({"status": if self.mode == "http_failure" || (!robots && ((self.mode == "partial_0" && source["source"] == "codexradar") || (self.mode == "partial_1" && source["source"] == "deepswe") || (self.mode == "partial_2" && source["source"] == "aixhan"))) {503} else if method == "HEAD" && self.mode == "head_405" {405} else if method == "HEAD" && self.mode == "head_501" {501} else if method == "HEAD" && self.mode == "head_forbidden" {403} else if robots && self.mode == "robots_missing" {404} else if robots && self.mode == "robots_gone" {410} else {200},
            "headers":{"content-type":if (!robots && self.mode == "html") || (robots && self.mode == "robots_html_large") {"text/html"} else if robots {"text/plain"} else {"application/json"},
                "content-length":if robots && self.mode == "robots_html_large" {916_003} else {content_length},
                "date":"Mon, 07 Sep 2026 07:44:00 GMT"}, "body_base64":STANDARD.encode(bytes)});
        if !robots && self.mode == "base64" { envelope["body_base64"] = json!("%%%invalid%%%"); }
        if !robots && (self.mode == "missing_date" || (self.mode == "partial_date" && source["source"] == "codexradar")) { envelope["headers"].as_object_mut().unwrap().remove("date"); }
        if Instant::now() >= self.deadline { return Err("plugin execution deadline exceeded".into()); }
        Ok(serde_json::to_vec(&envelope).unwrap())
    }
}
// Synthetic public shapes retain observed array counts and exact response sizes,
// without storing upstream bodies or identifying provider data.
fn public_size_fixture(source: &str, bytes: Vec<u8>, near_cap: bool) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    let target = match source {
        "deepswe" => {
            let row = value["rows"][0].clone();
            value["rows"] = json!((0..70).map(|i| { let mut r = row.clone(); r["model"] = json!(format!("synthetic-{i}")); r }).collect::<Vec<_>>());
            94_758
        },
        "aixhan" => {
            let timeline = value["providerTimelines"][0].clone();
            value["providerTimelines"] = json!((0..14).map(|i| {
                let mut t = timeline.clone();
                t["id"] = json!(format!("synthetic-{i}"));
                let item = t["items"][0].clone();
                t["items"] = json!(vec![item.clone(); if near_cap {100} else {40}]);
                t["latest"] = item;
                t
            }).collect::<Vec<_>>());
            if near_cap {950_000} else {275_580}
        },
        _ => return bytes,
    };
    value["synthetic_padding"] = json!("");
    let size = serde_json::to_vec(&value).unwrap().len();
    assert!(size <= target);
    value["synthetic_padding"] = json!("x".repeat(target - size));
    let bytes = serde_json::to_vec(&value).unwrap();
    assert_eq!(bytes.len(), target);
    bytes
}
// Every scenario receives a fresh host-equivalent store. Collect and normalize
// share its fuel and deadline; neither gets a reset between the two calls.
fn execution(engine: &Engine, component: &Component, linker: &Linker<State>, mode: &'static str, robots: &'static str)
    -> wasmtime::Result<(Store<State>, ServiceDataPlugin)> {
    let limits = StoreLimitsBuilder::new().memory_size(MEMORY).table_elements(100_000)
        .instances(8).tables(2).memories(2).build();
    let mut store = Store::new(engine, State { mode, calls: 0, data_calls: 0, robots_gets: 0, robots, limits, deadline: Instant::now() + TIMEOUT });
    store.limiter(|s| &mut s.limits);
    store.set_fuel(FUEL)?;
    store.set_epoch_deadline(TIMEOUT.as_millis().div_ceil(EPOCH_TICK.as_millis()) as u64);
    let bindings = ServiceDataPlugin::instantiate(&mut store, component, linker)?;
    Ok((store, bindings))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Config::new();
    config.wasm_component_model(true).consume_fuel(true).epoch_interruption(true);
    let engine = Engine::new(&config)?;
    let ticker = engine.clone();
    std::thread::spawn(move || loop { std::thread::sleep(EPOCH_TICK); ticker.increment_epoch(); });
    let component = Component::from_file(&engine, "plugin.wasm")?;
    let mut linker = Linker::<State>::new(&engine);
    ServiceDataPlugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |s| s)?;
    let input = include_str!("../../component/sources.json");
    let allow = "User-agent: *\nAllow: /\n";
    let mut fuel_used = 0;
    let mut measurements = Vec::new();
    let mut snapshots = Vec::new();
    let manifest: Value = serde_json::from_str(include_str!("../../plugin.json"))?;
    assert_eq!(manifest["contributions"]["service_data"][0]["timeout_millis"], TIMEOUT.as_millis() as u64);
    for mode in ["fixture", "mixed", "robots_missing", "robots_gone", "robots_html_large", "head_405", "head_501", "public_sizes", "near_cap", "best_after_24", "partial_0", "partial_1", "partial_2", "partial_json", "partial_shape", "partial_date", "robots_denied_one", "body_cap"] {
        println!("bounded component scenario: {mode}");
        let (mut store, bindings) = execution(&engine, &component, &linker, mode, allow)?;
        let guest = bindings.memeloop_token_center_service_data_v1();
        let collected = guest.call_collect(&mut store, "health-three-source-v1", input)?.expect("bounded real component collect");
        let collect_fuel = FUEL - store.get_fuel()?;
        assert!(collected.len() <= BODY_LIMIT);
        assert!(collected.len() < 65_536, "compact boundary must not contain raw source bodies");
        let no_robots_get = matches!(mode, "robots_missing" | "robots_gone" | "robots_html_large");
        assert_eq!(store.data().data_calls, if mode == "robots_denied_one" {2} else {3});
        assert_eq!(store.data().robots_gets, if no_robots_get {0} else {3});
        assert_eq!(store.data().calls, if no_robots_get {6} else if mode == "robots_denied_one" {8} else {9});
        let normalized = guest.call_normalize(&mut store, "health-snapshot-v1", input, &collected)?.expect("bounded real component normalize");
        assert!(normalized.len() <= BODY_LIMIT);
        assert!(Instant::now() < store.data().deadline);
        let snapshot: Value = serde_json::from_str(&normalized)?;
        snapshots.push(snapshot.clone());
        assert_eq!(snapshot["sources"].as_array().unwrap().len(), 3);
        let full_fuel = FUEL - store.get_fuel()?;
        measurements.push(json!({"scenario":mode,"collect_fuel":collect_fuel,"normalize_fuel":full_fuel-collect_fuel,"full_fuel":full_fuel,"compact_bytes":collected.len()}));
        println!("scenario {mode}: collect {collect_fuel}, full {full_fuel}/{FUEL}");
        if mode.starts_with("partial_") || mode == "robots_denied_one" || mode == "body_cap" {
            let failed = if mode == "partial_1" {1} else if mode == "partial_2" {2} else {0};
            for (i, source) in snapshot["sources"].as_array().unwrap().iter().enumerate() {
                assert_eq!(source["status"], if i == failed {"error"} else {"ok"});
                if i == failed {
                    assert_eq!(source["fetchedAt"], ""); assert!(source["sourceUpdatedAt"].is_null());
                    assert!(source["rows"].as_array().unwrap().is_empty());
                    assert_eq!(source["error"], if mode == "robots_denied_one" {"robots_denied"} else if mode == "body_cap" {"network"} else if mode == "partial_json" {"invalid_json"} else if mode == "partial_shape" {"invalid_payload"} else if mode == "partial_date" {"missing_source_date"} else {"http_status"});
                } else { assert!(!source["rows"].as_array().unwrap().is_empty()); }
            }
        }
        if mode == "best_after_24" { assert_eq!(snapshot["sources"][0]["rows"][0]["model"], "last-best"); }
        if mode == "fixture" {
            fuel_used = FUEL - store.get_fuel()?;
            std::fs::write("component-snapshot.json", normalized)?;
        }
        if mode == "mixed" {
            let source = &snapshot["sources"][2];
            assert_eq!(source["sourceUpdatedAt"], "2026-09-07T08:30:00.000Z");
            let row = source["rows"].as_array().unwrap().iter().find(|r| r["key"] == "mixed-one").unwrap();
            assert_eq!(row["name"], "newer");
            assert_eq!(row["status"], "operational");
            assert_eq!(row["checkedAt"], "2026-09-07T08:00:00.000Z");
        }
    }
    for robots in ["User-agent: *\n\n# comment\nDisallow: /\n",
        "User-agent: *\nDisallow: /\n\nUser-agent: other\nAllow: /\n"] {
        let (mut store, bindings) = execution(&engine, &component, &linker, "fixture", robots)?;
        assert_eq!(bindings.memeloop_token_center_service_data_v1().call_collect(&mut store, "health-three-source-v1", input)?.unwrap_err(), "all_sources_failed");
        assert_eq!((store.data().calls, store.data().data_calls), (6, 0), "denial must produce zero data requests");
    }
    for (mode, _expected) in [("http_failure", "http_status"), ("base64", "invalid_http_envelope"),
        ("head_forbidden", "http_status"), ("head_network", "network"), ("robots_text_large", "body_limit"), ("missing_date", "missing_source_date"), ("html", "content_type"), ("network", "network")] {
        let (mut store, bindings) = execution(&engine, &component, &linker, mode, allow)?;
        assert_eq!(bindings.memeloop_token_center_service_data_v1().call_collect(&mut store, "health-three-source-v1", input)?.unwrap_err(), "all_sources_failed");
    }
    let (mut deadline_store, deadline_bindings) = execution(&engine, &component, &linker, "fixture", allow)?;
    deadline_store.data_mut().deadline = Instant::now();
    assert_eq!(deadline_bindings.memeloop_token_center_service_data_v1().call_collect(&mut deadline_store, "health-three-source-v1", input)?.unwrap_err(), "all_sources_failed");
    let (mut trapped_store, trapped_bindings) = execution(&engine, &component, &linker, "fixture", allow)?;
    trapped_store.set_fuel(0)?;
    assert!(trapped_bindings.memeloop_token_center_service_data_v1().call_collect(&mut trapped_store, "health-three-source-v1", input).is_err(), "fuel traps never become partial successes");
    let (mut store, bindings) = execution(&engine, &component, &linker, "fixture", allow)?;
    let guest = bindings.memeloop_token_center_service_data_v1();
    assert!(guest.call_collect(&mut store, "health-three-source-v1", "{}")?.is_err());
    assert_eq!(store.data().calls, 0);
    assert!(guest.call_normalize(&mut store, "health-snapshot-v1", input, "[]")?.is_err());
    let compact = guest.call_collect(&mut store, "health-three-source-v1", input)?.unwrap();
    let compact: Value = serde_json::from_str(&compact)?;
    for mutation in ["source_order", "extra_field", "unknown_error", "invalid_date", "altered_row"] {
        let mut value = compact.clone();
        match mutation {
            "source_order" => value.as_array_mut().unwrap().swap(0,1),
            "extra_field" => value[0]["untrusted"] = json!(true),
            "unknown_error" => value[0]["error"] = json!("untrusted upstream exception"),
            "invalid_date" => value[0]["fetchedAt"] = json!("yesterday"),
            _ => value[0]["rows"][0]["untrusted"] = json!(true),
        }
        assert!(guest.call_normalize(&mut store, "health-snapshot-v1", input, &serde_json::to_string(&value)?)?.is_err(), "reject compact mutation {mutation}");
    }
    let mut all_errors = compact;
    for value in all_errors.as_array_mut().unwrap() {
        value["error"] = json!("network"); value["fetchedAt"] = Value::Null;
        value["sourceUpdatedAt"] = Value::Null; value["rows"] = json!([]);
    }
    assert_eq!(guest.call_normalize(&mut store, "health-snapshot-v1", input, &serde_json::to_string(&all_errors)?)?.unwrap_err(), "all_sources_failed");
    std::fs::write("component-scenarios.json", serde_json::to_vec(&snapshots)?)?;
    std::fs::write("component-bounds.json", serde_json::to_vec_pretty(&json!({
        "fuel":FUEL,"fixture_fuel_used":fuel_used,"measurements":measurements,"requires_service_data_fuel":100000000,"memory_bytes":MEMORY,"timeout_millis":TIMEOUT.as_millis(),
        "epoch_tick_millis":10,"body_limit":BODY_LIMIT,"shared_collect_normalize_budget":true,
        "robots_html_over_text_limit":true,"html_robots_content_length":916003,"html_robots_gets":0,"head_405_501_fallback":true,"public_response_sizes":[94758,275580],"robots_text_over_limit_rejected":true,"robots_404_410":true,
        "mixed_offset_ordering":true,"robots_denied_data_requests":0,"http_envelope_negatives":true
    }))?)?;
    println!("actual bounded Wasmtime component: fixture fuel {fuel_used}/{FUEL}, mixed offsets, robots zero data requests, envelope failures");
    Ok(())
}
