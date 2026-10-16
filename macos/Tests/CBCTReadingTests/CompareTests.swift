import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func testComparePinnedColumnMovesToFront() {
        let keys = ["a", "b", "c"]
        // 未固定：保持原顺序
        XCTAssertEqual(CompareLayout.orderedKeys(keys, pinned: nil), ["a", "b", "c"])
        // 固定中间列：提到最前，其余相对顺序不变
        XCTAssertEqual(CompareLayout.orderedKeys(keys, pinned: "b"), ["b", "a", "c"])
        // 固定末列
        XCTAssertEqual(CompareLayout.orderedKeys(keys, pinned: "c"), ["c", "a", "b"])
        // 已固定为首列：不变
        XCTAssertEqual(CompareLayout.orderedKeys(keys, pinned: "a"), ["a", "b", "c"])
        // 不改变元素数量（防止漏列/重复列）
        for pin in [nil, "a", "b", "c"] {
            let out = CompareLayout.orderedKeys(keys, pinned: pin)
            XCTAssertEqual(out.count, keys.count)
            XCTAssertEqual(Set(out), Set(keys))
        }
    }

    // 固定的列被移出选择集后必须失效，否则表头列数与数据列数会对不上
    func testComparePinnedColumnRemovedFromSelection() {
        let keys = ["a", "b"]
        XCTAssertNil(CompareLayout.reconciled(keys, pinned: "gone"))
        XCTAssertEqual(CompareLayout.reconciled(keys, pinned: "a"), "a")
        XCTAssertNil(CompareLayout.reconciled(keys, pinned: nil))
        XCTAssertNil(CompareLayout.reconciled([], pinned: "a"))
        // 失效的固定在纯函数里也必须退化为原顺序，不能凭空插入一列
        XCTAssertEqual(CompareLayout.orderedKeys(keys, pinned: "gone"), ["a", "b"])
    }

    func testComparePinnedToggleAndHighlight() {
        XCTAssertEqual(CompareLayout.toggled("a", current: nil), "a")
        XCTAssertEqual(CompareLayout.toggled("a", current: "a"), nil)
        XCTAssertEqual(CompareLayout.toggled("b", current: "a"), "b")
        XCTAssertTrue(CompareLayout.isPinned("a", pinned: "a"))
        XCTAssertFalse(CompareLayout.isPinned("a", pinned: "b"))
        XCTAssertFalse(CompareLayout.isPinned("a", pinned: nil))
    }

    // 固定列后导出的列序必须与屏幕一致，否则表格与导出对不上
    func testCompareExportFollowsPinnedOrder() {
        let keys = ["a", "b", "c"]
        let ordered = CompareLayout.orderedKeys(keys, pinned: "c")
        XCTAssertEqual(ordered, ["c", "a", "b"])
        let matrix = [["维度"] + ordered] + [["任务", "1", "2", "3"]]
        XCTAssertEqual(matrix[0], ["维度", "c", "a", "b"])
        XCTAssertEqual(matrix[1][0], "任务")
        XCTAssertEqual(matrix[1].count, matrix[0].count)
    }
}
