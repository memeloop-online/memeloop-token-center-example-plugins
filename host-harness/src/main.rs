use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime::component::{Component, HasSelf, Linker};
wasmtime::component::bindgen!({ path: "../wit", world: "service-data-plugin" });
const FUEL: u64 = 5_000_000;
const MEMORY: usize = 32 * 1024 * 1024;
const BODY_LIMIT: usize = 1_048_576;
const TIMEOUT: Duration = Duration::from_millis(4000);
const EPOCH_TICK: Duration = Duration::from_millis(10);
struct State {
    mode: &'static str, calls: usize, data_calls: usize, robots: &'static str,
    limits: StoreLimits, deadline: Instant,
}
impl memeloop::token_center::host::Host for State {
    fn log(&mut self, _: String, _: String) {}
    fn kv_get(&mut self, _: String) -> Result<Option<Vec<u8>>, String> { Err("unexpected KV".into()) }
    fn kv_put(&mut self, _: String, _: Vec<u8>) -> Result<(), String> { Err("unexpected KV".into()) }
    fn http_request(&mut self, method: String, url: String, headers: String, body: Vec<u8>) -> Result<Vec<u8>, String> {
        if Instant::now() >= self.deadline { return Err("plugin execution deadline exceeded".into()); }
        self.calls += 1;
        assert_eq!(method, "GET");
        assert!(body.is_empty());
        let headers: Value = serde_json::from_str(&headers).unwrap();
        assert_eq!(headers.as_object().unwrap().len(), 2);
        assert_eq!(headers["user-agent"], "mtc-health-intelligence/1.2.1 (public-readonly)");
        let config: Value = serde_json::from_str(include_str!("../../component/sources.json")).unwrap();
        let source = config["sources"].as_array().unwrap().iter()
            .find(|s| s["endpoint"] == url || s["robotsUrl"] == url).expect("exact approved URL");
        let robots = source["robotsUrl"] == url;
        assert_eq!(headers["accept"], if robots { "text/plain" } else { "application/json" });
        if !robots { self.data_calls += 1; }
        if !robots && self.mode == "network" { return Err("private transport exception".into()); }
        let mut bytes = if robots { self.robots.as_bytes().to_vec() }
            else { std::fs::read(format!("test/fixtures/{}.json", source["source"].as_str().unwrap())).unwrap() };
        if !robots && self.mode == "mixed" && source["source"] == "aixhan" {
            bytes = serde_json::to_vec(&json!({"providerTimelines":[
                {"latest":{"id":"mixed-one","name":"older","status":"error","checkedAt":"2026-09-07T15:00:00+08:00"},
                 "items":[{"id":"mixed-one","name":"newer","status":"operational","checkedAt":"2026-09-07T08:00:00Z"}]},
                {"items":[{"id":"mixed-two","name":"second","status":"degraded","checkedAt":"2026-09-07T08:30:00Z"}]}
            ]})).unwrap();
        }
        assert!(bytes.len() <= BODY_LIMIT, "same host response body cap");
        let mut envelope = json!({"status": if self.mode == "http_failure" {503} else if robots && self.mode == "robots_missing" {404} else {200},
            "headers":{"content-type":if !robots && self.mode == "html" {"text/html"} else if robots {"text/plain"} else {"application/json"},
                "date":"Mon, 07 Sep 2026 07:44:00 GMT"}, "body_base64":STANDARD.encode(bytes)});
        if !robots && self.mode == "base64" { envelope["body_base64"] = json!("%%%invalid%%%"); }
        if !robots && self.mode == "missing_date" { envelope["headers"].as_object_mut().unwrap().remove("date"); }
        if Instant::now() >= self.deadline { return Err("plugin execution deadline exceeded".into()); }
        Ok(serde_json::to_vec(&envelope).unwrap())
    }
}
// Every scenario receives a fresh host-equivalent store. Collect and normalize
// share its fuel and deadline; neither gets a reset between the two calls.
fn execution(engine: &Engine, component: &Component, linker: &Linker<State>, mode: &'static str, robots: &'static str)
    -> wasmtime::Result<(Store<State>, ServiceDataPlugin)> {
    let limits = StoreLimitsBuilder::new().memory_size(MEMORY).table_elements(100_000)
        .instances(8).tables(2).memories(2).build();
    let mut store = Store::new(engine, State { mode, calls: 0, data_calls: 0, robots, limits, deadline: Instant::now() + TIMEOUT });
    store.limiter(|s| &mut s.limits);
    store.set_fuel(FUEL)?;
    store.set_epoch_deadline(400);
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
    for mode in ["fixture", "mixed", "robots_missing"] {
        let (mut store, bindings) = execution(&engine, &component, &linker, mode, allow)?;
        let guest = bindings.memeloop_token_center_service_data_v1();
        let collected = guest.call_collect(&mut store, "health-three-source-v1", input)?.expect("bounded real component collect");
        assert!(collected.len() <= BODY_LIMIT);
        assert_eq!((store.data().calls, store.data().data_calls), (6, 3));
        let normalized = guest.call_normalize(&mut store, "health-snapshot-v1", input, &collected)?.expect("bounded real component normalize");
        assert!(normalized.len() <= BODY_LIMIT);
        assert!(Instant::now() < store.data().deadline);
        let snapshot: Value = serde_json::from_str(&normalized)?;
        assert_eq!(snapshot["sources"].as_array().unwrap().len(), 3);
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
        assert_eq!(bindings.memeloop_token_center_service_data_v1().call_collect(&mut store, "health-three-source-v1", input)?.unwrap_err(), "robots_denied");
        assert_eq!((store.data().calls, store.data().data_calls), (1, 0), "denial must produce zero data requests");
    }
    for (mode, expected) in [("http_failure", "http_status"), ("base64", "invalid_http_envelope"),
        ("missing_date", "missing_source_date"), ("html", "content_type"), ("network", "network")] {
        let (mut store, bindings) = execution(&engine, &component, &linker, mode, allow)?;
        assert_eq!(bindings.memeloop_token_center_service_data_v1().call_collect(&mut store, "health-three-source-v1", input)?.unwrap_err(), expected);
    }
    let (mut store, bindings) = execution(&engine, &component, &linker, "fixture", allow)?;
    let guest = bindings.memeloop_token_center_service_data_v1();
    assert!(guest.call_collect(&mut store, "health-three-source-v1", "{}")?.is_err());
    assert_eq!(store.data().calls, 0);
    assert!(guest.call_normalize(&mut store, "health-snapshot-v1", input, "[]")?.is_err());
    std::fs::write("component-bounds.json", serde_json::to_vec_pretty(&json!({
        "fuel":FUEL,"fixture_fuel_used":fuel_used,"memory_bytes":MEMORY,"timeout_millis":4000,
        "epoch_tick_millis":10,"body_limit":BODY_LIMIT,"shared_collect_normalize_budget":true,
        "mixed_offset_ordering":true,"robots_denied_data_requests":0,"http_envelope_negatives":true
    }))?)?;
    println!("actual bounded Wasmtime component: fixture fuel {fuel_used}/{FUEL}, mixed offsets, robots zero data requests, envelope failures");
    Ok(())
}
