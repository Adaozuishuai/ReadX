import Foundation

/// Runs the optional Pix2Text model locally. No image is sent to a remote service.
enum LocalFormulaOCR {
    private struct Formula: Decodable { var kind: String; var latex: String }
    private struct Response: Decodable {
        var formulas: [Formula]?
        var error: String?
        var message: String?
    }

    static func scriptURL(projectRoot: URL) -> URL {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("scripts/formula_ocr.py")
        if let bundled, FileManager.default.fileExists(atPath: bundled.path) { return bundled }
        return projectRoot.appendingPathComponent("macos/scripts/formula_ocr.py")
    }

    static func isFormulaCandidate(kind: String, latex: String) -> Bool {
        let value = latex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        if kind == "isolated" { return true }
        guard kind == "embedding", value.count >= 4 else { return false }
        // Page-level formula detection also labels standalone variables, units,
        // and legend text as embeddings. Keep expressions with an actual relation
        // or operation; wrappers such as \mathcal{M}_{H} are notation fragments,
        // not standalone equations to insert into the module flow.
        let operators = #"(?:[=+*/<>]|(?<!\\)-|\\(?:in|notin|subset|supset|leq|geq|approx|sim|to|rightarrow|leftarrow|Rightarrow|Leftrightarrow|cdot|times|pm|mp|neq|equiv|propto|sum|prod|int|frac|sqrt|partial|nabla)\b)"#
        return value.range(of: operators, options: .regularExpression) != nil
    }

    static func transcribe(png: Data, script: URL) throws -> String {
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw unavailable("本地公式识别脚本未找到。")
        }
        let process = Process()
        let venvPython = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CBCT每日精读/formula-ocr/bin/python3")
        if FileManager.default.isExecutableFile(atPath: venvPython.path) {
            process.executableURL = venvPython
            process.arguments = [script.path]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["python3", script.path]
        }
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() }
        catch { throw unavailable("找不到可用的 python3。请安装 Python 3 后重试。") }

        input.fileHandleForWriting.write(png)
        try? input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let response: Response
        do { response = try JSONDecoder().decode(Response.self, from: data) }
        catch {
            let preview = String(decoding: data.prefix(180), as: UTF8.self)
                .replacingOccurrences(of: "\\n", with: " ")
                .replacingOccurrences(of: "\\r", with: " ")
            throw NSError(domain: "local-formula-ocr", code: 2, userInfo: [NSLocalizedDescriptionKey: "本地公式识别器返回了无法读取的结果（退出码 \(process.terminationStatus)；\(preview)）。"])
        }
        if response.error == "missing_dependency" {
            throw unavailable("本地公式 OCR 尚未安装。可在项目根目录运行 `macos/scripts/install_formula_ocr.sh`，然后重新解析；首次使用会下载模型，之后可离线识别。")
        }
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "local-formula-ocr", code: 3, userInfo: [NSLocalizedDescriptionKey: "本地公式 OCR 失败：\(response.message ?? "请检查模型文件后重试。")"])
        }
        let blocks = (response.formulas ?? []).filter { isFormulaCandidate(kind: $0.kind, latex: $0.latex) }
        guard !blocks.isEmpty else {
            throw NSError(domain: "local-formula-ocr", code: 4, userInfo: [NSLocalizedDescriptionKey: "本地 OCR 未在本页可靠定位公式；没有生成或补造公式。"])
        }
        return blocks.enumerated().map { index, block in
            "% Local OCR formula \(index + 1) (\(block.kind))\n$$\n\(block.latex)\n$$"
        }.joined(separator: "\n\n")
    }

    private static func unavailable(_ message: String) -> NSError {
        NSError(domain: "local-formula-ocr", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
