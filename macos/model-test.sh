#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
sources=()
for source in Sources/CBCTReading/*.swift; do
  if [[ "$source" != */App.swift ]]; then sources+=("$source"); fi
done
swiftc -target "$(uname -m)-apple-macosx13.0" -parse-as-library "${sources[@]}" Tests/CBCTReadingTests/ModelAcceptance.swift -o .build/model-acceptance
.build/model-acceptance
