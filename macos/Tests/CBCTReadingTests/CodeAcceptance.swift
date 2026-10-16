import Foundation
import Darwin

// Reads a public repository at a frozen commit, never executes repository code.
// Optional mapping sends only the public NAF paper and these public code files.
@main struct CodeAcceptance {
    @MainActor static func main() async {
        setbuf(stdout, nil)
        do { try await run() }
        catch { print("Repository acceptance failed: " + error.localizedDescription); exit(1) }
    }
    @MainActor static func run() async throws {
        guard ProcessInfo.processInfo.environment["CBCT_CODE_TESTS"] == "1" else { print("Set CBCT_CODE_TESTS=1 for public repository acceptance."); return }
        let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).deletingLastPathComponent()
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("cbct-code-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("library"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Data(#"{"papers":[{"arxiv":"2209.14540","title":"Neural Attenuation Fields for Sparse-View CBCT Reconstruction"}]}"#.utf8).write(to: temporary.appendingPathComponent("queue.json"))
        try FileManager.default.copyItem(at: workspace.appendingPathComponent("library/2022-NAF-2209.14540.pdf"), to: temporary.appendingPathComponent("library/2209.14540.pdf"))
        let store = Store(root: temporary, startTimers: false)
        let output = workspace.appendingPathComponent("macos/acceptance/" + Store.nowISO() + "/" + (ProcessInfo.processInfo.environment["CBCT_ACCEPTANCE_RUN"] ?? "code-v1"))
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let snapshot: CodeSnapshot
        if let previous = ProcessInfo.processInfo.environment["CBCT_CODE_CACHE"] {
            let cached = try JSONDecoder().decode(CodeSnapshot.self, from: Data(contentsOf: URL(fileURLWithPath: previous)))
            try cached.validateSnapshot()
            if ProcessInfo.processInfo.environment["CBCT_CODE_RESCAN"] == "1" {
                snapshot = try await RepositoryService.scan(cached.repository.url, paperKey: cached.paperKey, cached: cached) { print($0) }
            } else { snapshot = cached; print("Reused public snapshot at commit " + snapshot.commit) }
        } else {
            snapshot = try await RepositoryService.scan("https://github.com/Ruyi-Zha/naf_cbct", paperKey: "2209.14540") { print($0) }
        }
        guard store.saveCodeSnapshot(snapshot) else { throw CodeError.invalidSnapshot }
        try encoder.encode(snapshot).write(to: output.appendingPathComponent("NAF-repository.json"), options: .atomic)
        print("Public scan: \(snapshot.files.count)/\(snapshot.paths.count) files · commit \(snapshot.commit)")
        for warning in snapshot.warnings { print("Scope: " + warning) }
        guard ProcessInfo.processInfo.environment["CBCT_MODEL_TESTS"] == "1" else { return }
        store.config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: workspace.appendingPathComponent("app/config.json")))
        guard store.config.hasKey else { print("Configured API unavailable; scan retained."); return }
        let session = SessionState(ref: store.reference(store.queue[0]), step: 2)
        let source = try await store.ensurePDFText(for: session.ref)
        try source.write(to: output.appendingPathComponent("NAF-source.txt"), atomically: true, encoding: .utf8)
        let began = Date(); store.generateCodeMapping(session)
        while session.codeBusy && Date().timeIntervalSince(began) < 300 { try await Task.sleep(nanoseconds: 100_000_000) }
        let error = session.codeBusy ? "Timed out" : store.codeErrors[session.ref.key]
        let updated = store.codeSnapshots[session.ref.key] ?? snapshot
        if let draft = store.codeDrafts[session.ref.key] { try draft.write(to: output.appendingPathComponent("NAF-mapping-response.json"), atomically: true, encoding: .utf8) }
        try encoder.encode(updated).write(to: output.appendingPathComponent("NAF-mapping.json"), options: .atomic)
        try encoder.encode(["status": error ?? "dual-source structural validation passed; semantic review pending", "seconds": String(Int(Date().timeIntervalSince(began))), "model": store.config.model ?? "unknown"]).write(to: output.appendingPathComponent("NAF-run.json"), options: .atomic)
        print(error ?? "Mapping structural validation passed; semantic review pending.")
        print("Saved public acceptance: " + output.path)
        if error != nil { exit(1) }
    }
}
