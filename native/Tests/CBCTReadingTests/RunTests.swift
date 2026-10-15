import Testing
@testable import CBCTReading

// 让 `swift test` 能发现并运行完整回归套件（35+ 用例）。
// 断言失败的用例会在 run() 内部计数并打印 FAIL 明细，这里只断言整体结果。
@Suite
struct RegressionSuite {
    @Test
    func fullRegressionSuite() async {
        #expect(await RegressionRunner.run())
    }
}
