use serde_json::Value;
use std::{error::Error, fs, path::Path};
// Same validator version, format and pattern options as the official host.
// Authoritative schema validation is not a signed installer receipt.
fn validator(schema: &Value) -> Result<jsonschema::Validator, Box<dyn Error>> {
    Ok(jsonschema::draft202012::options().should_validate_formats(true)
        .with_pattern_options(jsonschema::PatternOptions::regex()).build(schema)?)
}
fn main() -> Result<(), Box<dyn Error>> {
    let manifest: Value = serde_json::from_slice(&fs::read("plugin.json")?)?;
    let endpoint = &manifest["contributions"]["service_data"][0];
    let response = validator(&endpoint["response_schema"])?;
    assert!(response.is_valid(&endpoint["fallback"]));
    let actual: Value = serde_json::from_slice(&fs::read("component-snapshot.json")?)?;
    assert!(response.is_valid(&actual), "actual component output must satisfy declared schema");
    let scenarios: Vec<Value> = serde_json::from_slice(&fs::read("component-scenarios.json")?)?;
    for (i, scenario) in scenarios.iter().enumerate() {
        assert!(response.is_valid(scenario), "component scenario {i} must satisfy public schema");
    }
    for root in std::env::args().skip(1) {
        let schema: Value = serde_json::from_slice(&fs::read(Path::new(&root).join("schemas/plugin-manifest.schema.json"))?)?;
        let contract = validator(&schema)?;
        assert!(contract.is_valid(&manifest), "exact manifest must satisfy official schema: {root}");
        let mut invalid = manifest.clone();
        invalid["contributions"]["service_data"][0]["url"] = Value::String("https://codexradar.com/api/radar-insights".into());
        assert!(!contract.is_valid(&invalid), "URL and component must be mutually exclusive");
        invalid = manifest.clone();
        invalid["contributions"]["service_data"][0].as_object_mut().unwrap().remove("component_adapter");
        assert!(!contract.is_valid(&invalid), "one collector is required");
        invalid = manifest.clone();
        invalid["contributions"]["service_data"][0]["component_adapter"]["unknown"] = Value::Bool(true);
        assert!(!contract.is_valid(&invalid), "unknown adapter fields must be rejected");
    }
    println!("exact manifest, fallback and component output validated against official schema contracts; signed installer gate remains in publish");
    Ok(())
}
