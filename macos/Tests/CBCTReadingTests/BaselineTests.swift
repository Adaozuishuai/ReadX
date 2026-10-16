import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    // PRD 4.7 点名的六个方法必须都有卡片
    func testBaselineLibraryCoversPrdNamedMethods() {
        let required = ["FDK", "SART", "DuDoNet", "C²RV", "NeRP", "Trans²-CBCT"]
        for name in required {
            XCTAssertTrue(BaselineLibrary.cards.contains { $0.name == name },
                          "PRD 4.7 点名的方法缺卡片：" + name)
        }
        // 项目实际用到的 IntraTomo3D 也应有
        XCTAssertTrue(BaselineLibrary.cards.contains { $0.name == "IntraTomo3D" })
        // id 唯一
        let ids = BaselineLibrary.cards.map(\.id)
        XCTAssertEqual(ids.count, Set(ids).count)
    }

    // PRD 10.2 明确要求：能识别 FDK/SART 属于经典重建方法，而非深度学习网络
    func testClassicalMethodsAreNotNeuralNetworks() {
        let fdk = try? XCTUnwrap(BaselineLibrary.card(id: "fdk"))
        let sart = try? XCTUnwrap(BaselineLibrary.card(id: "sart"))
        let asd = try? XCTUnwrap(BaselineLibrary.card(id: "asd-pocs"))
        XCTAssertEqual(fdk?.kind, .analytical)
        XCTAssertEqual(sart?.kind, .iterative)
        XCTAssertEqual(asd?.kind, .iterative)
        XCTAssertFalse(fdk?.kind.isNeuralNetwork == true, "FDK 不得被标为神经网络")
        XCTAssertFalse(sart?.kind.isNeuralNetwork == true, "SART 不得被标为神经网络")
        // 深度学习/隐式方法应被标为网络
        XCTAssertTrue(BaselineLibrary.card(id: "nerp")?.kind.isNeuralNetwork == true)
        XCTAssertTrue(BaselineLibrary.card(id: "dudonet")?.kind.isNeuralNetwork == true)
    }

    // 别名匹配：论文里各种写法都要能命中同一张卡片
    func testBaselineAliasMatching() {
        let cases: [([String], String)] = [
            (["FDK"], "fdk"),
            (["FDK [7]"], "fdk"),
            (["filtered back-projection"], "fdk"),
            (["SART [2]"], "sart"),
            (["ASD-POCS [20]"], "asd-pocs"),
            (["IntraTomo3D [28]"], "intratomo3d"),
            (["NeRP"], "nerp"),
            (["C2RV"], "c2rv"),
            (["Trans^2-CBCT"], "trans2-cbct"),
        ]
        for (input, expected) in cases {
            let hits = BaselineLibrary.matches(baselineNames: input)
            XCTAssertTrue(hits.contains { $0.0.id == expected },
                          "别名未命中：\(input) 应匹配 \(expected)，实际 \(hits.map(\.0.id))")
        }
    }

    // 未收录的基线名不得被硬塞进某张卡片
    func testUnknownBaselineDoesNotFalselyMatch() {
        let hits = BaselineLibrary.matches(baselineNames: ["Completely Unknown Method XYZ"])
        XCTAssertTrue(hits.isEmpty, "未收录的方法不应误匹配：" + hits.map(\.0.name).description)
        XCTAssertTrue(BaselineLibrary.matches(baselineNames: []).isEmpty)
        XCTAssertTrue(BaselineLibrary.matches(baselineNames: [""]).isEmpty)
    }

    // 同一方法只输出一次卡片，避免重复
    func testBaselineMatchesAreDeduplicated() {
        let hits = BaselineLibrary.matches(baselineNames: ["FDK", "FDK [7]", "FDK"])
        XCTAssertEqual(hits.filter { $0.0.id == "fdk" }.count, 1)
    }

    // 「与当前论文的关系」只区分提到/未提到，不做优劣推断
    func testBaselineRelationIsNeutral() {
        let fdk = try? XCTUnwrap(BaselineLibrary.card(id: "fdk"))
        guard let fdk else { return }
        let mentioned = BaselineLibrary.relation(fdk, baselineNames: ["FDK [7]"])
        XCTAssertTrue(mentioned.contains("包含 FDK"))
        let notMentioned = BaselineLibrary.relation(fdk, baselineNames: ["SART"])
        XCTAssertTrue(notMentioned.contains("未见 FDK"))
        // 不得出现优劣判断词
        for text in [mentioned, notMentioned] {
            for word in ["更好", "更强", "优于", "首选"] {
                XCTAssertFalse(text.contains(word), "关系描述不应含优劣判断：" + text)
            }
        }
    }

    // 不确定的字段必须留 nil 并标 needsReview，不得编造代码链接
    func testUncertainCardsAreMarkedNeedsReview() {
        for card in BaselineLibrary.cards {
            XCTAssertFalse(card.coreIdea.isEmpty, "核心思想不能为空：" + card.name)
            XCTAssertFalse(card.task.isEmpty, "任务不能为空：" + card.name)
            if card.source == .needsReview {
                // 标为待核对的卡片必须有可核对的具体项（这里用 origin 缺失体现）
                XCTAssertTrue(card.origin == nil || card.codeURL == nil,
                              "标为待核对但字段齐全，可能过度自信：" + card.name)
            }
        }
        // 至少要有一张「待核对」卡片，证明该标记确实被使用而不是摆设
        XCTAssertTrue(BaselineLibrary.cards.contains { $0.source == .needsReview })
        XCTAssertTrue(BaselineLibrary.cards.contains { $0.source == .known })
    }
}
