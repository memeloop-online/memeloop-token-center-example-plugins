//! Pure Codex manual-reset-credit expiry planner. All authority stays in the host.
wit_bindgen::generate!({ path: "wit", world: "background-actions-plugin" });

use exports::memeloop::background_actions::planner::{Context, Guest, ResetCreditIntent};
use serde::Deserialize;
use std::collections::BTreeSet;

const LEAD_MS: i64 = 600_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {}

fn plan(input: Context) -> Result<Option<ResetCreditIntent>, String> {
    if input.config_json.len() > 1024 {
        return Err("configuration exceeds bound".into());
    }
    let _: Configuration = serde_json::from_str(&input.config_json)
        .map_err(|_| "invalid configuration: expected an empty object")?;
    if input.now_ms < 0
        || input.authorization_revision <= 0
        || input.tenant_external_id.is_empty()
        || input.upstream_account_id.is_empty()
        || input.inventory_fingerprint.is_empty()
        || input.credits.len() > 1024
    {
        return Err("invalid authorized host context".into());
    }
    let mut seen = BTreeSet::new();
    for credit in &input.credits {
        if credit.fingerprint.is_empty()
            || !seen.insert(&credit.fingerprint)
            || credit.granted_at_ms < 0
            || credit.granted_at_ms > input.now_ms
            || credit.expires_at_ms <= credit.granted_at_ms
        {
            return Err("invalid credit inventory".into());
        }
    }
    // The host supplies only available credits. Never interpret quota reset_at
    // or remaining balance as a manual-reset-credit expiry.
    let Some(credit) = input
        .credits
        .iter()
        .filter(|credit| credit.expires_at_ms > input.now_ms)
        .min_by_key(|credit| (credit.expires_at_ms, credit.fingerprint.as_str()))
    else {
        return Ok(None);
    };
    let not_before_ms = credit
        .expires_at_ms
        .checked_sub(LEAD_MS)
        .ok_or("invalid expiry arithmetic")?
        .max(credit.granted_at_ms);
    if input.now_ms < not_before_ms {
        return Ok(None);
    }
    Ok(Some(ResetCreditIntent {
        credit_fingerprint: credit.fingerprint.clone(),
        inventory_fingerprint: input.inventory_fingerprint,
        not_before_ms,
        deadline_ms: credit.expires_at_ms,
    }))
}

struct ExpiringReset;
impl Guest for ExpiringReset {
    fn plan(input: Context) -> Result<Option<ResetCreditIntent>, String> {
        plan(input)
    }
}
#[cfg(target_arch = "wasm32")]
export!(ExpiringReset);

#[cfg(test)]
mod tests {
    use super::*;
    use exports::memeloop::background_actions::planner::Credit;

    fn context(now_ms: i64) -> Context {
        Context {
            now_ms,
            tenant_external_id: "tenant".into(),
            upstream_account_id: "account".into(),
            authorization_revision: 1,
            config_json: "{}".into(),
            credits: vec![Credit {
                fingerprint: "credit-a".into(),
                granted_at_ms: 0,
                expires_at_ms: 1_000_000,
            }],
            inventory_fingerprint: "inventory-v1".into(),
        }
    }

    #[test]
    fn exact_ten_minute_boundary_and_expiry_are_half_open() {
        assert!(plan(context(399_999)).unwrap().is_none());
        for now in [400_000, 999_999] {
            let intent = plan(context(now)).unwrap().unwrap();
            assert_eq!(intent.credit_fingerprint, "credit-a");
            assert_eq!(intent.inventory_fingerprint, "inventory-v1");
            assert_eq!(intent.not_before_ms, 400_000);
            assert_eq!(intent.deadline_ms, 1_000_000);
        }
        assert!(plan(context(1_000_000)).unwrap().is_none());
    }

    #[test]
    fn repeated_plans_and_input_permutations_preserve_intent_identity() {
        let mut input = context(500_000);
        input.credits.push(Credit {
            fingerprint: "credit-b".into(),
            granted_at_ms: 0,
            expires_at_ms: 1_000_000,
        });
        for _ in 0..5 {
            input.credits.reverse();
            let intent = plan(input.clone()).unwrap().unwrap();
            assert_eq!(intent.credit_fingerprint, "credit-a");
            assert_eq!(intent.inventory_fingerprint, "inventory-v1");
            assert_eq!(intent.not_before_ms, 400_000);
        }
    }

    #[test]
    fn earliest_available_credit_wins_and_expired_credit_is_skipped() {
        let mut input = context(500_000);
        input.credits.push(Credit {
            fingerprint: "earlier".into(),
            granted_at_ms: 0,
            expires_at_ms: 800_000,
        });
        assert_eq!(plan(input).unwrap().unwrap().credit_fingerprint, "earlier");
        let mut input = context(1_000_000);
        input.credits.push(Credit {
            fingerprint: "later".into(),
            granted_at_ms: 0,
            expires_at_ms: 1_500_000,
        });
        assert_eq!(plan(input).unwrap().unwrap().credit_fingerprint, "later");
    }

    #[test]
    fn short_lived_credit_never_has_intent_before_grant() {
        let mut input = context(100);
        input.credits[0].granted_at_ms = 100;
        input.credits[0].expires_at_ms = 200;
        assert_eq!(plan(input).unwrap().unwrap().not_before_ms, 100);
    }

    #[test]
    fn missing_authority_malformed_time_and_ambiguous_inventory_fail_closed() {
        for change in 0..8 {
            let mut input = context(500_000);
            match change {
                0 => input.authorization_revision = 0,
                1 => input.tenant_external_id.clear(),
                2 => input.upstream_account_id.clear(),
                3 => input.inventory_fingerprint.clear(),
                4 => input.now_ms = -1,
                5 => input.credits[0].granted_at_ms = 500_001,
                6 => input.credits[0].expires_at_ms = i64::MIN,
                _ => input.credits.push(input.credits[0].clone()),
            }
            assert!(plan(input).is_err());
        }
        let mut input = context(i64::MAX - 1);
        input.credits[0].expires_at_ms = i64::MAX;
        assert_eq!(plan(input).unwrap().unwrap().deadline_ms, i64::MAX);
    }

    #[test]
    fn configuration_cannot_enable_balance_or_quota_window_triggers() {
        for config in ["null", "[]", "{\"reset_at\":1}", "{\"lead_minutes\":5}"] {
            let mut input = context(500_000);
            input.config_json = config.into();
            assert!(plan(input).is_err());
        }
        let mut input = context(500_000);
        input.credits.clear();
        assert!(plan(input).unwrap().is_none());
    }
}
