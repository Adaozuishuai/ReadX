import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func testSystemTagsCoverEightCategories() {
        // PRD 7.2 要求系统标签至少覆盖八类
        XCTAssertEqual(SystemTagCategory.allCases.count, 8)
        for category in SystemTagCategory.allCases {
            XCTAssertTrue(SystemTags.vocabulary[category] != nil, "缺少类别词表：" + category.rawValue)
            XCTAssertTrue(SystemTags.vocabulary[category]?.isEmpty == false, "类别词表为空：" + category.rawValue)
        }
    }

    func testSystemTagsDeriveFromPaperText() {
        let fields = ["Sparse-view CBCT reconstruction with implicit neural fields",
                      "We use hash encoding and a small MLP. Trained self-supervised on LUNA16 with PSNR and SSIM.",
                      "MICCAI 2022", "simulated projections via TIGRE"]
        let tags = SystemTags.derive(from: fields)
        let pairs = tags.map { $0.category.rawValue + "|" + $0.value }
        XCTAssertTrue(pairs.contains("Task|Sparse-view"))
        XCTAssertTrue(pairs.contains("Domain|Implicit 3D"))
        XCTAssertTrue(pairs.contains("Architecture|MLP"))
        XCTAssertTrue(pairs.contains("Architecture|Hash Grid"))
        XCTAssertTrue(pairs.contains("Learning Paradigm|Self-supervised"))
        XCTAssertTrue(pairs.contains("Dataset|LUNA16"))
        XCTAssertTrue(pairs.contains("Metric|PSNR"))
        XCTAssertTrue(pairs.contains("Metric|SSIM"))
        XCTAssertTrue(pairs.contains("Venue|MICCAI"))
        XCTAssertTrue(pairs.contains("Acquisition|Simulated"))
        // 命中项必须带证据词，否则用户无法核对
        for tag in tags { XCTAssertFalse(tag.evidence.isEmpty, "缺少依据：" + tag.value) }
    }

    // 命不中就不输出——不允许推测（沿用 evidence-first 原则）
    func testSystemTagsDoNotInventOnWeakEvidence() {
        XCTAssertTrue(SystemTags.derive(from: []).isEmpty)
        XCTAssertTrue(SystemTags.derive(from: ["a paper about nothing in particular"]).isEmpty)
        // 只提到 PSNR，就不能同时冒出 SSIM/RMSE
        let onlyPsnr = SystemTags.derive(from: ["we report PSNR"])
        XCTAssertEqual(onlyPsnr.filter { $0.category == .metric }.map(\.value), ["PSNR"])
    }

    func testSystemTagsNoDuplicatesAndStableOrder() {
        let fields = ["sparse-view sparse view few-view", "psnr PSNR PSNR"]
        let tags = SystemTags.derive(from: fields)
        let ids = tags.map { $0.category.rawValue + "|" + $0.value }
        XCTAssertEqual(ids.count, Set(ids).count, "出现重复标签")
        // 同一输入两次派生结果一致（顺序稳定）
        XCTAssertEqual(SystemTags.derive(from: fields), tags)
        // 按类别顺序输出
        let order = tags.map { SystemTagCategory.allCases.firstIndex(of: $0.category)! }
        XCTAssertEqual(order, order.sorted())
    }

    func testSystemTagCoverageCounts() {
        let tags = SystemTags.derive(from: ["Sparse-view with PSNR and SSIM"])
        let coverage = SystemTags.coverage(tags)
        XCTAssertEqual(coverage.count, 8)
        XCTAssertEqual(coverage.first { $0.0 == .metric }?.1, 2)
        XCTAssertEqual(coverage.first { $0.0 == .task }?.1, 1)
        XCTAssertEqual(coverage.first { $0.0 == .venue }?.1, 0)
        // 覆盖率必须能定位到具体缺失类别
        let missing = coverage.filter { $0.1 == 0 }.map { $0.0 }
        XCTAssertTrue(missing.contains(.venue))
        XCTAssertFalse(missing.contains(.metric))
    }

    // 论文文本为空时不得凭空产生标签（避免「所有论文都带同一批标签」的假象）
    @MainActor
    func testSystemTagsOnEmptyPaperAreEmpty() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let empty = QueueEntry(id: "empty-paper", title: nil, authors: nil, venue: nil)
        XCTAssertTrue(store.systemTags(for: empty).isEmpty)
    }

    // 从真实论文条目派生：应至少命中 Task/Domain 之一，且不写入用户标签
    @MainActor
    func testSystemTagsDoNotTouchUserTags() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.mutateLibrary("2209.14540") { $0.tags = ["我的自定义标签"] }
        let before = store.state("2209.14540").tags
        _ = store.systemTags(for: store.queue[0])
        XCTAssertEqual(store.state("2209.14540").tags, before, "系统标签不得覆盖用户标签")
        XCTAssertEqual(store.state("2209.14540").tags, ["我的自定义标签"])
    }
}
