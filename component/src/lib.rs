use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
wit_bindgen::generate!({ path: "../wit", world: "service-data-plugin" });
struct Collector;
export!(Collector);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    source: String, label: String, page_url: String, endpoint: String,
    robots_url: String, data_path: String, max_observation_age_seconds: u64, normalizer: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Config { sources: Vec<Source> }
fn config(input: &str) -> Result<Config, String> {
    let value: Value = serde_json::from_str(input).map_err(|_| "invalid_config")?;
    let approved: Value = serde_json::from_str(include_str!("../sources.json")).unwrap();
    if value != approved { return Err("unapproved_source_config".into()); }
    serde_json::from_value(value).map_err(|_| "invalid_config".into())
}
fn date(value: &Value) -> Option<String> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|v| v.with_timezone(&chrono::Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").chars().map(|c| if c.is_control() { ' ' } else { c }).take(160).collect::<String>().trim().into()
}
fn num(value: &Value) -> Value {
    value.as_f64().filter(|v| v.is_finite()).map_or(Value::Null, |v| json!(v))
}
fn samples(value: &Value) -> u64 { value.as_f64().unwrap_or(0.0).clamp(0.0, 1e9).floor() as u64 }
fn fraction(value: &Value) -> Option<f64> {
    let v = value.as_f64()?;
    let v = if v > 1.0 { v / 100.0 } else { v };
    (0.0..=1.0).contains(&v).then_some(v)
}
fn bounded(value: &Value, max: f64) -> Value {
    value.as_f64().filter(|v| *v >= 0.0 && *v <= max).map_or(Value::Null, |v| json!(v))
}
fn rows(source: &Source, body: &Value) -> Result<(Option<String>, Vec<Value>), String> {
    let (key, updated) = match source.normalizer.as_str() {
        "codexradar_v1" => ("comprehensive_points", date(&body["source_updated_at"]).or_else(|| date(&body["generated_at"]))),
        "deepswe_v1" => ("rows", date(&body["generated_at"])),
        "aixhan_v1" => ("providerTimelines", None),
        _ => return Err("invalid_normalizer".into()),
    };
    let input = body[key].as_array().ok_or("invalid_payload")?;
    let mut result = Vec::new();
    for item in input {
        if source.normalizer == "aixhan_v1" {
            let mut items: Vec<&Value> = item["items"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
            if item["latest"].is_object() { items.push(&item["latest"]); }
            items.sort_by_key(|v| date(&v["checkedAt"]));
            let Some(latest) = items.last() else { continue; };
            let mut name = text(&latest["name"]);
            if name.is_empty() { name = text(&item["name"]); }
            let status = text(&latest["status"]).to_lowercase();
            if name.is_empty() || status.is_empty() { continue; }
            let status = match status.as_str() { "operational" | "degraded" | "error" => status.as_str(), _ => "unknown" };
            let id = text(&latest["id"]);
            result.push(json!({"key": if id.is_empty() { &name } else { &id }, "name": name,
                "model": nullable_text(&latest["model"]), "providerType": nullable_text(&latest["type"]),
                "status": status, "latencyMs": bounded(&latest["latencyMs"], 86400000.0),
                "pingLatencyMs": bounded(&latest["pingLatencyMs"], 86400000.0),
                "checkedAt": date(&latest["checkedAt"]), "message": nullable_text(&latest["message"])}));
        } else {
            let model = text(&item["model"]);
            let effort = text(&item[if source.normalizer == "codexradar_v1" { "effort" } else { "reasoning_effort" }]);
            if model.is_empty() || effort.is_empty() { continue; }
            let id: String = format!("{model}:{effort}").chars().take(180).collect();
            if source.normalizer == "codexradar_v1" {
                let Some(iq) = item["iq"].as_f64().filter(|v| (0.0..=200.0).contains(v)) else { continue; };
                result.push(json!({"key":id,"model":model,"effort":effort,"iq":iq,
                    "softwareIq":num(&item["software_iq"]),"visualIq":num(&item["visual_iq"]),"samples":samples(&item["samples"])}));
            } else {
                let Some(rate) = fraction(&item["pass_rate"]) else { continue; };
                result.push(json!({"key":id,"model":model,"effort":effort,"passRate":rate,
                    "passAt4":fraction(&item["pass_at_4"]),"averageCostUsd":bounded(&item["mean_cost_usd"],1e6),
                    "outputTokens":bounded(&item["mean_output_tokens"],f64::MAX),
                    "agentSteps":bounded(&item["mean_agent_steps"],f64::MAX),"samples":samples(&item["n_attempted"])}));
            }
        }
    }
    if !input.is_empty() && result.is_empty() { return Err("invalid_payload".into()); }
    if source.normalizer == "aixhan_v1" {
        fn rank(v: &Value) -> usize { match v["status"].as_str() { Some("error")=>0,Some("degraded")=>1,Some("unknown")=>2,_=>3 } }
        result.sort_by(|a,b| rank(a).cmp(&rank(b)).then_with(|| a["key"].as_str().cmp(&b["key"].as_str())));
    } else {
        let score = if source.normalizer == "codexradar_v1" { "iq" } else { "passRate" };
        result.sort_by(|a,b| b[score].as_f64().partial_cmp(&a[score].as_f64()).unwrap().then_with(|| a["key"].as_str().cmp(&b["key"].as_str())));
    }
    let updated = if source.normalizer == "aixhan_v1" { result.iter().filter_map(|v| v["checkedAt"].as_str()).max().map(str::to_owned) } else { updated };
    result.truncate(24);
    Ok((updated, result))
}
fn nullable_text(value: &Value) -> Value { let v = text(value); if v.is_empty() { Value::Null } else { json!(v) } }
fn robots_allowed(body: &str, path: &str) -> bool {
    let mut active = false;
    let mut directives = false;
    let mut best: Option<(usize,bool)> = None;
    for line in body.lines().take(2000) {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        let Some((name,value)) = line.split_once(':') else { continue; };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "user-agent" {
            if directives { active = false; directives = false; }
            active |= value == "*";
        } else {
            directives = true;
            if !active || (name != "allow" && name != "disallow") { continue; }
            if !value.is_empty() && path.starts_with(value) {
                let allowed = name == "allow";
                if best.is_none_or(|(len,yes)| value.len() > len || (value.len() == len && allowed && !yes)) { best = Some((value.len(),allowed)); }
            }
        }
    }
    best.is_none_or(|(_,yes)| yes)
}
// Borrow the potentially large base64 body rather than copying it into a JSON Value.
#[derive(Deserialize)]
struct HttpEnvelope<'a> {
    status: u64,
    headers: Value,
    #[serde(borrow)]
    body_base64: Option<&'a str>,
}
fn request(url: &str, robots: bool) -> Result<(Vec<u8>, Option<String>), String> {
    let headers = json!({"accept":if robots {"text/plain"} else {"application/json"},
        "user-agent":"mtc-health-intelligence/1.2.1 (public-readonly)"}).to_string();
    let bytes = memeloop::token_center::host::http_request("GET",url,&headers,&[]).map_err(|_| "network")?;
    let envelope: HttpEnvelope = serde_json::from_slice(&bytes).map_err(|_| "invalid_http_envelope")?;
    let status = envelope.status;
    if robots && (status == 404 || status == 410) { return Ok((vec![],None)); }
    if !(200..300).contains(&status) { return Err("http_status".into()); }
    let content_type = envelope.headers["content-type"].as_str().unwrap_or("").to_lowercase();
    if content_type.contains("text/html") {
        if robots { return Ok((vec![],None)); }
        return Err("content_type".into());
    }
    let body = STANDARD.decode(envelope.body_base64.ok_or("invalid_http_envelope")?).map_err(|_| "invalid_http_envelope")?;
    if body.len() > if robots {65536} else {1048576} { return Err("body_limit".into()); }
    let fetched = envelope.headers["date"].as_str().and_then(|v| DateTime::parse_from_rfc2822(v).ok()).map(|v| v.with_timezone(&chrono::Utc).to_rfc3339_opts(SecondsFormat::Millis,true));
    Ok((body,fetched))
}
impl exports::memeloop::token_center::service_data_v1::Guest for Collector {
    fn collect(id: String, input: String) -> Result<String,String> {
        if id != "health-three-source-v1" { return Err("invalid_collector".into()); }
        let config = config(&input)?;
        let mut values = Vec::new();
        for source in config.sources {
            let (robots,_) = request(&source.robots_url,true)?;
            if !robots_allowed(std::str::from_utf8(&robots).map_err(|_| "robots_unavailable")?,&source.data_path) { return Err("robots_denied".into()); }
            let (body,fetched) = request(&source.endpoint,false)?;
            let fetched = fetched.ok_or("missing_source_date")?;
            let body: Value = serde_json::from_slice(&body).map_err(|_| "invalid_json")?;
            values.push(json!({"source":source.source,"fetchedAt":fetched,"body":body}));
        }
        let output = serde_json::to_string(&values).map_err(|_| "component_output")?;
        if output.len() > 1048576 { return Err("body_limit".into()); }
        Ok(output)
    }
    fn normalize(id: String, input: String, collected: String) -> Result<String,String> {
        if id != "health-snapshot-v1" { return Err("invalid_normalizer".into()); }
        let config = config(&input)?;
        let values: Vec<Value> = serde_json::from_str(&collected).map_err(|_| "invalid_payload")?;
        if values.len() != config.sources.len() { return Err("invalid_payload".into()); }
        let mut snapshots = Vec::new();
        for (source,value) in config.sources.iter().zip(&values) {
            if value["source"] != source.source { return Err("invalid_payload".into()); }
            let fetched = date(&value["fetchedAt"]).ok_or("invalid_source_date")?;
            let (updated,rows) = rows(source,&value["body"])?;
            snapshots.push(json!({"id":source.source,"label":source.label,"pageUrl":source.page_url,
                "endpoint":source.endpoint,"status":"ok","fetchedAt":fetched,"sourceUpdatedAt":updated,
                "maxObservationAgeSeconds":source.max_observation_age_seconds,"attempts":2,"error":null,"rows":rows}));
        }
        let generated = snapshots.iter().filter_map(|v| v["fetchedAt"].as_str()).max().ok_or("invalid_payload")?;
        serde_json::to_string(&json!({"schemaVersion":1,"generatedAt":generated,"sources":snapshots})).map_err(|_| "component_output".into())
    }
}
