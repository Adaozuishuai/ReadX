// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CBCTReading",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "CBCTReading", path: "Sources/CBCTReading"),
        // 回归套件（swift test 可发现）；两个带 @main 的在线验收 harness 保持排除，
        // 仍由 code-test.sh / model-test.sh 单独编译运行。
        .testTarget(name: "CBCTReadingTests", dependencies: ["CBCTReading"], path: "Tests/CBCTReadingTests",
                    exclude: ["CodeAcceptance.swift", "ModelAcceptance.swift"])
    ]
)
