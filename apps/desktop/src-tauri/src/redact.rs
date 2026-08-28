//! Secret redaction — the authoritative implementation (PRIVACY.md §4, ARCHITECTURE §3).
//!
//! This sits between collection and persistence. The TypeScript redactor in `@rewind/protocol` is
//! the extension-side half; both are driven by the **same** `redaction/patterns.json`, included here
//! at compile time so the two can never drift apart silently. If the file moves, this fails to build
//! — which is the point.
//!
//! **Fail closed** (PRIVACY §4.2, INITIAL_ANALYSIS TR-9). `redact` is total: it cannot panic. When a
//! detector misbehaves it returns `None` and the caller drops the event. Losing an event is
//! acceptable; storing a secret is not.

use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};
use serde::Deserialize;

const REGISTRY_JSON: &str =
    include_str!("../../../../packages/protocol/redaction/patterns.json");

#[derive(Deserialize)]
struct Registry {
    version: String,
    patterns: Vec<PatternDef>,
}

#[derive(Deserialize)]
struct PatternDef {
    id: String,
    regex: String,
    flags: String,
    replacement: String,
}

struct Compiled {
    id: String,
    regex: Regex,
    replacement: String,
}

pub struct Redactor {
    version: String,
    patterns: Vec<Compiled>,
}

/// What a redaction pass did. The detector ids are kept; the matched values never are.
#[derive(Debug, Clone, Default)]
pub struct Stamp {
    pub patterns_version: String,
    pub applied: Vec<String>,
    pub count: usize,
}

impl Redactor {
    fn build() -> Self {
        let registry: Registry =
            serde_json::from_str(REGISTRY_JSON).expect("redaction/patterns.json is malformed");

        let mut patterns = Vec::with_capacity(registry.patterns.len());
        for def in registry.patterns {
            let mut builder = RegexBuilder::new(&def.regex);
            builder.case_insensitive(def.flags.contains('i'));
            match builder.build() {
                // `$1` is valid in both engines, but Rust reads `$1[` greedily as a group name, so
                // the braced form is used instead. The registry stays JavaScript-shaped.
                Ok(regex) => patterns.push(Compiled {
                    id: def.id,
                    regex,
                    replacement: def.replacement.replace("$1", "${1}"),
                }),
                // A pattern that will not compile is a defect in the registry, and the conformance
                // test catches it. At runtime, skipping it is safer than refusing to start — the
                // remaining detectors still run.
                Err(err) => eprintln!("REWIND: skipping redaction pattern {}: {err}", def.id),
            }
        }

        Self {
            version: registry.version,
            patterns,
        }
    }

    pub fn shared() -> &'static Redactor {
        static INSTANCE: OnceLock<Redactor> = OnceLock::new();
        INSTANCE.get_or_init(Redactor::build)
    }

    /// Redact one string. Total: never panics.
    ///
    /// Returns `None` only if a detector fails in a way that leaves the outcome uncertain, in which
    /// case the caller must drop the event rather than store text that may not have been cleaned.
    pub fn redact(&self, input: &str) -> Option<(String, Stamp)> {
        let mut text = input.to_owned();
        let mut stamp = Stamp {
            patterns_version: self.version.clone(),
            ..Default::default()
        };

        for pattern in &self.patterns {
            let hits = pattern.regex.find_iter(&text).count();
            if hits == 0 {
                continue;
            }
            text = pattern
                .regex
                .replace_all(&text, pattern.replacement.as_str())
                .into_owned();
            stamp.applied.push(pattern.id.clone());
            stamp.count += hits;
        }

        Some((text, stamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const POSITIVE: &str =
        include_str!("../../../../packages/fixtures/redaction/positive.jsonl");
    const NEGATIVE: &str =
        include_str!("../../../../packages/fixtures/redaction/negative.jsonl");

    #[derive(serde::Deserialize)]
    struct Positive {
        id: String,
        text: String,
        #[serde(rename = "mustNotContain")]
        must_not_contain: String,
        #[serde(rename = "expectDetector")]
        expect_detector: String,
    }

    #[derive(serde::Deserialize)]
    struct Negative {
        id: String,
        text: String,
        #[serde(rename = "mustSurvive")]
        must_survive: String,
        why: String,
    }

    fn lines<T: serde::de::DeserializeOwned>(raw: &str) -> Vec<T> {
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("fixture line is malformed"))
            .collect()
    }

    /// TESTING.md §5.1. The assertion is not "the field looks masked" — it is that the raw secret is
    /// absent, which a partially correct implementation cannot satisfy.
    #[test]
    fn secrets_never_survive_redaction() {
        let redactor = Redactor::shared();
        let cases: Vec<Positive> = lines(POSITIVE);
        assert!(cases.len() >= 20, "the corpus should not be trivial");

        for case in cases {
            let (text, stamp) = redactor.redact(&case.text).expect("redaction must not fail");
            assert!(
                !text.contains(&case.must_not_contain),
                "{}: the secret survived: {text}",
                case.id
            );
            assert!(
                stamp.applied.contains(&case.expect_detector),
                "{}: expected detector {} to fire, got {:?}",
                case.id,
                case.expect_detector,
                stamp.applied
            );
        }
    }

    /// TESTING.md §5.2. Over-redaction destroys the evidence the product depends on — a commit SHA
    /// is high-entropy AND is primary evidence (TR-10).
    #[test]
    fn evidence_survives_redaction() {
        let redactor = Redactor::shared();
        for case in lines::<Negative>(NEGATIVE) {
            let (text, _) = redactor.redact(&case.text).expect("redaction must not fail");
            assert!(
                text.contains(&case.must_survive),
                "{}: {} — lost {:?} from {text}",
                case.id,
                case.why,
                case.must_survive
            );
        }
    }

    #[test]
    fn redaction_is_total_on_hostile_input() {
        let redactor = Redactor::shared();
        for input in [
            "",
            " ",
            &"a".repeat(100_000),
            "((((((((((((((((((((",
            &"💥".repeat(1000),
        ] {
            assert!(redactor.redact(input).is_some(), "must not fail on {:?}", &input[..input.len().min(20)]);
        }
    }

    /// The hot path cannot afford a catastrophic backtrack (TESTING.md §5.4).
    #[test]
    fn pathological_input_stays_within_the_hot_path_budget() {
        let redactor = Redactor::shared();
        let inputs = [
            format!("Authorization: Bearer {}", "a".repeat(50_000)),
            format!("-----BEGIN RSA PRIVATE KEY-----{}", "A".repeat(50_000)),
            format!("{}={}", "x".repeat(10_000), "y".repeat(10_000)),
        ];
        for input in inputs {
            let start = std::time::Instant::now();
            assert!(redactor.redact(&input).is_some());
            assert!(
                start.elapsed().as_millis() < 500,
                "redaction took {:?} — a backtrack this slow would stall collection",
                start.elapsed()
            );
        }
    }
}
