# Catalog regression baseline

`baseline.json` captures the independent reference implementation's results before
v1 removal: tags, year windows, research statements, repository checks and identity
matching. The Go tests compare every fixture against this frozen contract, without
loading any legacy code. New cases require independently reviewed expectations.
