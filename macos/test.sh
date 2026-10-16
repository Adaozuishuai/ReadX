#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
sources=()
for source in Sources/CBCTReading/*.swift; do
  if [[ "$source" != */App.swift ]]; then sources+=("$source"); fi
done
# RegressionRunner 不再自带 @main（swift test 的 testTarget 与裸编译共用同一文件），由此处提供入口
cat > .build/TestMain.swift <<'MAIN'
import Foundation
@main struct TestMain {
    static func main() async {
        let ok = await RegressionRunner.run()
        exit(ok ? 0 : 1)
    }
}
MAIN
swiftc -target "$(uname -m)-apple-macosx13.0" -parse-as-library "${sources[@]}" Tests/CBCTReadingTests/ResearchTests.swift Tests/CBCTReadingTests/CodeTests.swift Tests/CBCTReadingTests/ResultTests.swift Tests/CBCTReadingTests/CitationTests.swift Tests/CBCTReadingTests/CompareTests.swift Tests/CBCTReadingTests/SystemTagTests.swift Tests/CBCTReadingTests/TrendTests.swift Tests/CBCTReadingTests/BaselineTests.swift Tests/CBCTReadingTests/MarkdownTableTests.swift .build/TestMain.swift -o .build/research-tests
.build/research-tests
