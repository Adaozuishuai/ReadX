import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func codeFixture() throws -> CodeSnapshot {
        CodeSnapshot(paperKey: "2209.14540", repository: try RepositoryID.parse("https://github.com/example/CBCT"), commit: String(repeating: "a", count: 40), scannedAt: "2026-10-02", paths: ["model.py"], files: [CodeFile(path: "model.py", sha: String(repeating: "b", count: 40), category: "模型 / 几何", text: "class Field:\n    def forward(self, x):\n        return self.encoder(x)", truncated: false)], warnings: [])
    }
    func testRepositoryURLsAndFileCoverage() throws {
        XCTAssertEqual(try RepositoryID.parse(" https://github.com/Ruyi-Zha/naf_cbct.git ").slug, "Ruyi-Zha/naf_cbct")
        for bad in ["http://github.com/a/b", "https://evil.com/a/b", "https://token@github.com/a/b", "https://github.com/a/b?token=secret", "https://github.com/a/b/tree/main", "https://github.com/a/...git", "https://github.com/a/.."] { XCTAssertThrowsError(try RepositoryID.parse(bad)) }
        let paths = ["README.md", "requirements.txt", "config/a.yaml", "dataset.py", "loss.py", "train.py", "eval.py", "model.py"] + (0..<30).map { "config/\($0).yaml" }
        func entry(_ path: String, mode: String = "100644", size: Int = 100) -> RepositoryService.TreeItem { .init(path: path, mode: mode, type: "blob", sha: "sha", size: size) }
        let chosen = RepositoryService.selected(paths.map { entry($0) })
        XCTAssertEqual(chosen.count, 24)
        for path in paths.prefix(8) where path != "config/a.yaml" { XCTAssertTrue(chosen.contains { $0.path == path }, "Missing category entry: " + path) }
        XCTAssertTrue(chosen.contains { RepositoryService.category($0.path) == "配置" })
        for path in [".env", "config/secrets.json", "api_key.txt", "../model.py", "node_modules/foo.py"] { XCTAssertFalse(RepositoryService.eligible(entry(path))) }
        XCTAssertFalse(RepositoryService.eligible(entry("model.py", mode: "120000")))
        XCTAssertFalse(RepositoryService.eligible(entry("model.py", size: 200_000)))
        let snapshot = try codeFixture()
        XCTAssertTrue(snapshot.fileURL(path: "model.py", line: 2)?.absoluteString.contains("/" + snapshot.commit + "/model.py#L2") == true)
        XCTAssertNil(snapshot.fileURL(path: "../model.py"))
    }
    func testCodeMappingEvidence() throws {
        let source = "=== Page 2 ===\nWe use an implicit neural representation for CT reconstruction."
        let snapshot = try codeFixture()
        var item = CodeMapping(concept: "Field", paper: ExperimentField(k: "Representation", v: "implicit neural representation", page: 2, excerpt: "We use an implicit neural representation"), path: "model.py", startLine: 2, endLine: 3, codeExcerpt: "return self.encoder(x)", symbol: "forward", reasoning: "AI inference from definition; algorithm equivalence unverified", confidence: 0.7)
        func validate(_ value: CodeMapping) throws { try CodeMappingAnalysis(mappings: [value], missing: []).validate(source: source, snapshot: snapshot) }
        XCTAssertNoThrow(try validate(item))
        item.startLine = 1; item.endLine = 1; XCTAssertThrowsError(try validate(item))
        item.startLine = 2; item.endLine = 99; XCTAssertThrowsError(try validate(item))
        item.endLine = 3; item.path = "invented.py"; XCTAssertThrowsError(try validate(item))
        item.path = "model.py"; item.codeExcerpt = "return invented(x)"; XCTAssertThrowsError(try validate(item))
        item.codeExcerpt = "return self.encoder(x)"; item.paper.page = 99; XCTAssertThrowsError(try validate(item))
        item.paper.page = 2; item.codeExcerpt = "return self.encoder(-x)"; XCTAssertThrowsError(try validate(item))
        item.codeExcerpt = "return self.encoder(x)"
        item.paper.page = 2; item.confidence = 1.1; XCTAssertThrowsError(try validate(item))
        item.confidence = 0.7; item.symbol = "invented_function"; XCTAssertThrowsError(try validate(item))
        item.symbol = "forward"; item.paper.v = "128 channels"; XCTAssertThrowsError(try validate(item))
        item.paper.v = "implicit neural representation"
        XCTAssertThrowsError(try CodeMappingAnalysis(mappings: [item, item], missing: []).validate(source: source, snapshot: snapshot))
    }
    @MainActor func testCodePersistenceAndCorruption() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        var snapshot = try codeFixture()
        let item = CodeMapping(concept: "Field", paper: ExperimentField(k: "Representation", v: "implicit representation", page: 2, excerpt: "We use an implicit neural representation"), path: "model.py", startLine: 2, endLine: 3, codeExcerpt: "return self.encoder(x)", symbol: "forward", reasoning: "AI inference", confidence: 0.7)
        snapshot.mappingJSON = String(decoding: try JSONEncoder().encode(CodeMappingAnalysis(mappings: [item], missing: [])), as: UTF8.self)
        snapshot.mappingSource = "=== Page 2 ===\nWe use an implicit neural representation for CT reconstruction."
        XCTAssertTrue(store.saveCodeSnapshot(snapshot))
        XCTAssertFalse(store.confirmCodeMapping(key: snapshot.paperKey, mappingID: item.id, note: " "))
        XCTAssertFalse(store.confirmCodeMapping(key: snapshot.paperKey, mappingID: "invented", note: "checked"))
        XCTAssertTrue(store.confirmCodeMapping(key: snapshot.paperKey, mappingID: item.id, note: "Checked cited page and function; no execution claim"))
        let reloaded = Store(root: root, startTimers: false)
        XCTAssertEqual(reloaded.codeSnapshots[snapshot.paperKey]?.confirmations?[item.id], "Checked cited page and function; no execution claim")
        XCTAssertEqual(reloaded.codeSnapshots[snapshot.paperKey]?.mappingSource, snapshot.mappingSource)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.codeDir.appendingPathComponent("history").path).count, 1)
        let url = store.codeDir.appendingPathComponent(snapshot.paperKey + ".json")
        try Data("broken".utf8).write(to: url)
        reloaded.loadCodeSnapshots()
        XCTAssertTrue(reloaded.codeLoadFailures.contains(snapshot.paperKey)); XCTAssertFalse(reloaded.saveCodeSnapshot(snapshot))
        XCTAssertEqual(try String(contentsOf: url), "broken")
        snapshot.paperKey = "../escape"; XCTAssertFalse(store.saveCodeSnapshot(snapshot))
        try FileManager.default.removeItem(at: store.codeDir)
        try Data("not a directory".utf8).write(to: store.codeDir)
        store.loadCodeSnapshots(); XCTAssertTrue(store.codeDirectoryFailed)
        snapshot.paperKey = "2209.14540"; XCTAssertFalse(store.saveCodeSnapshot(snapshot))
    }
}
