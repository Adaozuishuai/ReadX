# Migration regression baseline

`baseline.json` records the independent reference implementation's output for
every fixture before the v1 source and runtime were removed. It covers validation
decisions, diagnostics, repaired content and demoted fields.

Go tests compare against these frozen expectations without Node.js or v1 code.
When adding cases, review their expected behavior explicitly; do not regenerate
the baseline from the implementation being tested.
