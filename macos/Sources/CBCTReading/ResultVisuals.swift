import SwiftUI
import PDFKit
import Vision

struct ResultVisualReading: Codable {
    var observations: [ExperimentField]
    var interpretation: String
    var category: String

    static func decode(_ raw: String) throws -> Self {
        let text = JSONExtract.object(from: raw)
        return try JSONDecoder().decode(Self.self, from: Data(text.utf8))
    }
    /// The model selects OCR line IDs; the application supplies the exact evidence
    /// text. This prevents visual answers from paraphrasing or inventing OCR quotes.
    static func decode(_ raw: String, page: Int, ocr: String) throws -> Self {
        struct Selection: Decodable { var k: String; var ocrLineIDs: [Int] }
        struct Draft: Decodable { var observations: [Selection]; var interpretation: String; var category: String? }
        let text = JSONExtract.object(from: raw)
        let draft = try JSONDecoder().decode(Draft.self, from: Data(text.utf8))
        let lines = ocr.components(separatedBy: .newlines)
        var observations: [ExperimentField] = []
        for selection in draft.observations {
            for id in Set(selection.ocrLineIDs).sorted() {
                guard id > 0, lines.indices.contains(id - 1), Evidence.normalized(lines[id - 1]).count >= 2 else {
                    throw NSError(domain: "visual", code: 4, userInfo: [NSLocalizedDescriptionKey: "图内 OCR 引用不存在：\(id)。未补造标签或数字。"])
                }
                let quote = lines[id - 1]
                observations.append(.init(k: selection.k, v: quote, page: page, excerpt: quote))
            }
        }
        return Self(observations: observations, interpretation: draft.interpretation, category: draft.category ?? "other")
    }
    func validate(page: Int, ocr: String) throws {
        guard !observations.isEmpty, observations.allSatisfy({ $0.page == page && $0.excerpt != nil }) else {
            throw NSError(domain: "visual", code: 1, userInfo: [NSLocalizedDescriptionKey: "图表解读没有图内可定位依据。"])
        }
        // Axis/legend labels can be short (PSNR, SSIM, GT). Unlike prose excerpts,
        // accept short labels, but require the reported value to be a literal copy
        // from this crop's OCR, with no added claim or invented reading.
        for field in observations {
            let quote = Evidence.normalized(field.excerpt ?? "")
            guard quote.count >= 2, Evidence.normalized(ocr).contains(quote),
                  Evidence.normalized(field.v) == quote else {
                throw NSError(domain: "visual", code: 3, userInfo: [NSLocalizedDescriptionKey: "图内观察必须逐字复制本图 OCR 标签或读数，不能添加未被摘录支持的事实：" + field.k])
            }
        }
        let numbers = observations.reduce(into: Set<String>()) { $0.formUnion(Evidence.numbers($1.v)) }
        guard Evidence.numbers(interpretation).isSubset(of: numbers) else {
            throw NSError(domain: "visual", code: 2, userInfo: [NSLocalizedDescriptionKey: "图表解释包含未被图内摘录支持的数字，已保留原图供核对。"])
        }
    }
}

struct ResultVisual: Codable, Identifiable {
    var id: String
    var page: Int
    var caption: String
    var kind: String
    /// JPEG bytes are persisted with the reading cache; no external URLs or arbitrary file reads.
    var jpeg: Data?
    var ocr: String
    var reading: ResultVisualReading? = nil
    var error: String? = nil
}

enum ResultVisualSource {
    static func augmented(_ selected: String, fullSource: String, visuals: [ResultVisual]) -> String {
        let fullPages = Evidence.pages(fullSource)
        var included = Evidence.pages(selected)
        for page in fullPages where visuals.contains(where: { $0.page == page.number }) && !included.contains(where: { $0.number == page.number }) {
            included.append(page)
        }
        // 披露语与正文子集自带的「材料范围」互补：这里只说明图表合并与图内 OCR 的口径。
        return "【图表材料合并】在正文子集之外并入目标图表所在物理页与图内 OCR，共覆盖 \(included.count)/\(fullPages.count) 个物理页；图内 OCR 为视觉转写待核对，不把刻度推断为数据点。\n" + included.sorted { $0.number < $1.number }.map { page in
            let crops = visuals.filter { $0.page == page.number && !$0.ocr.isEmpty }
                .map { "\n【\($0.id) 图内 OCR，仅该裁剪区域】\n" + $0.ocr }.joined(separator: "\n")
            return "=== Page \(page.number) ===\n" + page.text + crops
        }.joined(separator: "\n\n")
    }
    static func catalog(_ visuals: [ResultVisual]) -> String {
        visuals.map { asset in
            let analysis = asset.reading.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) } ?? "视觉结论未可靠解析，勿补造读数。"
            return "\(asset.id) · \(asset.kind) · Page \(asset.page) · \(asset.caption)\n" + analysis + (asset.error.map { "\n待核对：" + $0 } ?? "")
        }.joined(separator: "\n\n")
    }
}

enum ResultVisualLocator {
    struct Hit: Equatable {
        var id: String
        var page: Int
        var caption: String
        var kind: String
    }
    static func find(in source: String) -> [Hit] {
        let pages = Evidence.pages(source)
        let resultStart = pages.first { $0.text.range(of: "(?im)^\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s+)?results(?:\\s|$)", options: .regularExpression) != nil }?.number
        let experimentStart = resultStart ?? pages.first { $0.text.range(of: "(?im)^\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:experiments?|evaluation)(?:\\s|$)", options: .regularExpression) != nil }?.number
        // PDFLayout uses ` | ` between text on the same physical row in two
        // columns. Treat that separator as a caption boundary too; `\s*` would
        // cross line breaks and merge captions from neighboring columns.
        let regex = try! NSRegularExpression(pattern: "(?im)(?:^|\\|)[ \\t]*(fig\\.?|figure|table)[ \\t]*(\\d+)[ \\t]*[.:]?[ \\t]*[^\\n|]{0,220}")
        var hits: [Hit] = [], seen = Set<String>()
        for page in pages {
            if let experimentStart, page.number < experimentStart { continue }
            let ns = page.text as NSString
            for match in regex.matches(in: page.text, range: NSRange(location: 0, length: ns.length)) {
                let kind = ns.substring(with: match.range(at: 1)).lowercased().hasPrefix("table") ? "table" : "figure"
                let number = ns.substring(with: match.range(at: 2))
                let caption = ns.substring(with: match.range)
                    .replacingOccurrences(of: "^[ \\t]*\\|[ \\t]*", with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if experimentStart == nil, kind == "figure", caption.range(of: "(?i)architecture|pipeline|framework|overview", options: .regularExpression) != nil { continue }
                let id = (kind == "table" ? "table" : "fig") + number
                if seen.insert(id).inserted { hits.append(Hit(id: id, page: page.number, caption: caption, kind: kind)) }
            }
        }
        return hits
    }
}

/// Caption-local crops support figures below their image and tables above their grid.
/// A failed crop remains an explicit placeholder; a full page never substitutes for a figure.
enum ResultVisualCrop {
    static let cacheVersion = 1
    static func cacheIsCurrent(_ storedVersion: Int?) -> Bool { storedVersion == cacheVersion }

    struct Line { var text: String; var box: CGRect }
    static func region(for hit: ResultVisualLocator.Hit, lines: [Line]) -> CGRect? {
        let number = hit.id.filter(\.isNumber)
        let pattern = hit.kind == "table" ? "(?i)^[ \\t]*table[ \\t]*\(number)(?![0-9])" : "(?i)^[ \\t]*(?:fig\\.?|figure)[ \\t]*\(number)(?![0-9])"
        let captionCandidates = lines.filter { $0.text.range(of: pattern, options: .regularExpression) != nil }
        let titleWords = hit.caption.lowercased().split { !$0.isLetter && !$0.isNumber }
            .map(String.init).filter { $0.count >= 4 && $0 != "table" && $0 != "figure" }
        let caption = captionCandidates.max { left, right in
            func score(_ line: Line) -> Int {
                let text = line.text.lowercased()
                return titleWords.reduce(0) { $0 + (text.contains($1) ? 1 : 0) }
            }
            let leftScore = score(left), rightScore = score(right)
            return leftScore == rightScore ? left.text.count < right.text.count : leftScore < rightScore
        } ?? captionCandidates.first
        guard let caption else { return nil }
        // Vision's physical box is reliable here. PDFPage text selection can
        // return a box in reading order that crosses both columns.
        let box = caption.box
        // A narrow caption identifies its own column even when no neighboring
        // figure/table has a caption on the same horizontal band. This prevents
        // adjacent-column prose from entering the crop and gives the table the
        // whole column width, beyond the caption's own text width.
        var minX: CGFloat = 0.025, maxX: CGFloat = 0.975
        if box.width < 0.52 {
            if box.midX < 0.5 { maxX = 0.5 }
            else { minX = 0.5 }
        }
        // Parallel captions define separate columns. Do not borrow neighbouring axes.
        let siblings = lines.filter { line in
            abs(line.box.midY - box.midY) < 0.055 &&
                line.text.range(of: "(?i)^\\s*(?:fig\\.?|figure|table)\\s*\\d+", options: .regularExpression) != nil &&
                abs(line.box.midX - box.midX) > 0.18
        }
        for sibling in siblings {
            if sibling.box.midX > box.midX {
                let boundary = (box.maxX + sibling.box.minX) / 2
                maxX = min(maxX, boundary - 0.005)
            } else {
                let boundary = (sibling.box.maxX + box.minX) / 2
                minX = max(minX, boundary + 0.005)
            }
        }
        func intersectsColumn(_ line: Line) -> Bool { line.box.midX > minX && line.box.midX < maxX }
        func prose(_ line: Line) -> Bool {
            line.text.count > 80 && line.text.split(separator: " ").filter { $0.rangeOfCharacter(from: .letters) != nil }.count > 12
        }
        func tableProse(_ line: Line) -> Bool {
            let words = line.text.split(separator: " ").filter { $0.rangeOfCharacter(from: .letters) != nil }.count
            let body = line.text
                .replacingOccurrences(of: #"\[\d+\]"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"(?i)(?:figure|fig\.?|table)[ \t]*\d+"#, with: "", options: .regularExpression)
            let hasNumber = body.range(of: #"\d"#, options: .regularExpression) != nil
            let endsSentence = line.text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"[.;:]$"#, options: .regularExpression) != nil
            return prose(line) || (!hasNumber && (endsSentence || (line.text.count > 30 && words >= 4)))
        }
        var lower: CGFloat
        let upper: CGFloat
        if hit.kind == "figure" {
            lower = box.maxY + 0.008
            let boundary = lines.filter { intersectsColumn($0) && $0.box.minY > lower && prose($0) }.map(\.box.minY).min()
            upper = min(0.975, lower + 0.52, boundary.map { $0 - 0.008 } ?? 1)
        } else {
            // Follow the closest compact text-row cluster beneath the caption.
            // A fixed-height crop includes adjacent prose and can cut off the
            // bottom rows of small tables, especially in two-column papers.
            let candidates = lines.filter {
                intersectsColumn($0) && $0.box.maxY < box.minY - 0.003 &&
                    $0.box.minY > box.minY - 0.36 && !tableProse($0) &&
                    $0.text.range(of: #"(?i)^[ \t]*(?:fig\.?|figure|table)[ \t]*\d+"#, options: .regularExpression) == nil
            }.sorted { $0.box.midY > $1.box.midY }
            var groups: [[Line]] = []
            for line in candidates {
                if let last = groups.indices.last,
                   let previous = groups[last].last,
                   previous.box.minY - line.box.maxY <= 0.025 {
                    groups[last].append(line)
                } else {
                    groups.append([line])
                }
            }
            if let rows = groups.first(where: { $0.count >= 2 }),
               let first = rows.first, let last = rows.last {
                // Keep the first detected grid row while excluding wrapped
                // caption prose that sits just below the caption's OCR line.
                upper = min(0.975, first.box.maxY - 0.002)
                lower = max(0.025, last.box.minY - 0.008)
                let otherCaption = lines.filter {
                    intersectsColumn($0) && $0.box.midY < box.midY - 0.055 &&
                        $0.box.maxY < box.minY - 0.025 &&
                        $0.text.range(of: #"(?i)^[ \t]*(?:fig\.?|figure|table)[ \t]*\d+"#, options: .regularExpression) != nil
                }.max { $0.box.maxY < $1.box.maxY }
                if let otherCaption { lower = max(lower, otherCaption.box.maxY + 0.001) }
            } else {
                // Keep a conservative fallback when OCR cannot see enough
                // table rows; downstream evidence validation will mark values
                // that cannot be read rather than treating them as confirmed.
                upper = box.minY - 0.008
                let boundary = lines.filter {
                    intersectsColumn($0) && $0.box.maxY < upper && prose($0)
                }.map(\.box.minY).max()
                lower = max(0.025, upper - 0.36, boundary.map { $0 - 0.008 } ?? 0)
            }
        }
        guard upper - lower > 0.035, maxX - minX > 0.12 else { return nil }
        return CGRect(x: minX, y: lower, width: maxX - minX, height: upper - lower)
    }

    /// Tighten the already caption-bounded region to its visible content.
    /// Do not stop at internal white gaps: multi-panel figures and tables often
    /// contain large blank bands that are part of the same object.
    static func isolatedObject(_ image: CGImage, kind: String = "figure") -> CGImage? {
        let width = image.width, height = image.height, stride = width * 4
        var bytes = [UInt8](repeating: 255, count: stride * height)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: stride,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        var top = height, bottom = 0, left = width, right = 0
        for y in 0..<height {
            for x in 0..<width {
                let index = y * stride + x * 4
                if min(bytes[index], bytes[index + 1], bytes[index + 2]) < 228 {
                    top = min(top, y); bottom = max(bottom, y)
                    left = min(left, x); right = max(right, x)
                }
            }
        }
        guard right > left, bottom > top else { return nil }
        // A caption-bounded crop can still include a running page header (for a
        // figure) or the next figure below a table. Split only across a broad,
        // truly empty horizontal band, and keep the content block nearest the
        // caption. Shorter internal gaps stay intact so multi-panel figures are
        // preserved as one image.
        let activeThreshold = max(2, width / 600)
        var activeRows: [Int] = []
        for y in top...bottom {
            var count = 0
            for x in left...right {
                let index = y * stride + x * 4
                if min(bytes[index], bytes[index + 1], bytes[index + 2]) < 228 { count += 1 }
            }
            if count >= activeThreshold { activeRows.append(y) }
        }
        if activeRows.count > 1 {
            let gapLimit = max(12, Int(Double(height) * 0.06))
            var groups: [(Int, Int)] = []
            var start = activeRows[0], end = activeRows[0]
            for row in activeRows.dropFirst() {
                if row - end > gapLimit {
                    groups.append((start, end)); start = row
                }
                end = row
            }
            groups.append((start, end))
            if groups.count > 1 {
                let selected: (Int, Int)
                if kind == "table" {
                    selected = groups.max { ($0.1 - $0.0) < ($1.1 - $1.0) } ?? groups[0]
                } else {
                    selected = groups.last!
                }
                top = selected.0; bottom = selected.1
            }
        }
        left = max(0, left - 6); right = min(width, right + 7)
        top = max(0, top - 6); bottom = min(height, bottom + 7)
        return image.cropping(to: CGRect(x: left, y: top, width: right - left, height: bottom - top))
    }

    static func extract(url: URL, hits: [ResultVisualLocator.Hit]) throws -> [ResultVisual] {
        guard let doc = PDFDocument(url: url) else { throw NSError(domain: "visual", code: 3) }
        var output: [ResultVisual] = []
        for pageNumber in Set(hits.map(\.page)).sorted() {
            guard let page = doc.page(at: pageNumber - 1) else { continue }
            let bounds = page.bounds(for: .mediaBox)
            let thumbnail = page.thumbnail(of: CGSize(width: bounds.width * 3, height: bounds.height * 3), for: .mediaBox)
            guard let cg = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
            let lines = (request.results ?? []).compactMap { observation -> Line? in
                observation.topCandidates(1).first.map { Line(text: $0.string, box: observation.boundingBox) }
            }
            for hit in hits.filter({ $0.page == pageNumber }) {
                var asset = ResultVisual(id: hit.id, page: hit.page, caption: hit.caption, kind: hit.kind, jpeg: nil, ocr: "")
                if let region = region(for: hit, lines: lines) {
                    let rect = CGRect(x: region.minX * CGFloat(cg.width), y: (1 - region.maxY) * CGFloat(cg.height), width: region.width * CGFloat(cg.width), height: region.height * CGFloat(cg.height)).integral
                    let crop = cg.cropping(to: rect).flatMap { image in
                        hit.kind == "table" ? image : isolatedObject(image, kind: hit.kind)
                    }
                    asset.jpeg = crop.flatMap { Store.compressedJPEG($0, maxDimension: 2400, quality: 0.85) }
                    // OCR the actual crop again, rather than borrowing page paragraphs.
                    if let crop {
                        let cropRequest = VNRecognizeTextRequest()
                        cropRequest.recognitionLevel = .accurate; cropRequest.usesLanguageCorrection = false
                        try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([cropRequest])
                        asset.ocr = (cropRequest.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                    }
                }
                if asset.jpeg == nil { asset.error = "未可靠定位该图表区域，请打开原文核对；未用整页代替图表。" }
                output.append(asset)
            }
        }
        // Preserve every located caption even if its page could not be rendered.
        for hit in hits where !output.contains(where: { $0.id == hit.id }) {
            output.append(ResultVisual(id: hit.id, page: hit.page, caption: hit.caption, kind: hit.kind, jpeg: nil, ocr: "", error: "页面渲染失败，请核对原文。"))
        }
        return output.sorted { $0.page == $1.page ? $0.id < $1.id : $0.page < $1.page }
    }
}

extension Store {
    func prepareResultVisuals(_ session: SessionState, source: String, regenerate: Bool) async {
        session.resultVisualBusy = true
        defer { session.resultVisualBusy = false; session.resultVisualPhase = "" }
        let hits = ResultVisualLocator.find(in: source)
        let cachedReading = loadReadings(session.ref.key)
        let previousVisuals = cachedReading?.resultVisuals ?? []
        let staleCropCache = !ResultVisualCrop.cacheIsCurrent(cachedReading?.resultVisualVersion)
        session.resultVisuals = (regenerate || staleCropCache) ? [] : previousVisuals
        session.resultVisuals.removeAll { asset in !hits.contains(where: { $0.id == asset.id && $0.page == asset.page }) }
        do {
            session.resultVisualPhase = "定位并裁剪结果图表…"
            let url = try await ensurePDF(for: session.ref)
            let missing = hits.filter { hit in !session.resultVisuals.contains(where: { $0.id == hit.id && $0.jpeg != nil }) }
            let crops = try await Task.detached(priority: .userInitiated) { try ResultVisualCrop.extract(url: url, hits: missing) }.value
            for var crop in crops {
                if staleCropCache && !regenerate,
                   let old = previousVisuals.first(where: { $0.id == crop.id && $0.page == crop.page }),
                   old.ocr == crop.ocr {
                    // Existing OCR line IDs remain valid only when the recognized
                    // crop text is byte-for-byte unchanged.
                    crop.reading = old.reading
                    crop.error = old.error
                }
                session.resultVisuals.removeAll { $0.id == crop.id }
                session.resultVisuals.append(crop)
            }
            for index in session.resultVisuals.indices {
                var visual = session.resultVisuals[index]
                guard visual.kind == "figure", let jpeg = visual.jpeg, visual.reading == nil else { continue }
                session.resultVisualPhase = "解析 \(visual.id) · Page \(visual.page)…"
                var feedback = ""
                for attempt in 0..<2 {
                    do {
                        let raw = try await AIService.analyzeResultVisual(imageData: jpeg, page: visual.page, caption: visual.caption, ocr: visual.ocr, config: config, feedback: feedback)
                        let reading = try ResultVisualReading.decode(raw, page: visual.page, ocr: visual.ocr)
                        try reading.validate(page: visual.page, ocr: visual.ocr)
                        visual.reading = reading; visual.error = nil
                        break
                    } catch {
                        visual.error = "图中结论待核对：" + error.localizedDescription
                        // Transport/model support errors cannot be fixed by another prompt.
                        guard error is DecodingError || (error as NSError).domain == "visual" else { break }
                        if attempt == 0 {
                            feedback = "上次输出未通过结构或 OCR 依据校验：" + String(describing: error) + "。重新输出完整 JSON，observations 每项仅有 k 和 ocrLineIDs，必须包含 interpretation 和 category；只选择现有 OCR 行号，不新增读数。"
                            session.resultVisualPhase = "校验并重试 " + visual.id + "…"
                        }
                    }
                }
                session.resultVisuals[index] = visual
            }
            session.resultVisuals.sort { $0.page == $1.page ? $0.id < $1.id : $0.page < $1.page }
            var cached = loadReadings(session.ref.key) ?? ReadingFile(key: session.ref.key)
            cached.resultVisuals = session.resultVisuals
            cached.resultVisualVersion = ResultVisualCrop.cacheVersion
            if !saveReadings(cached) { session.resultVisualError = dataError ?? "图表缓存保存失败。" }
        } catch { session.resultVisualError = error.localizedDescription }
    }
}

struct ResultVisualView: View {
    var asset: ResultVisual
    var onEvidence: (Int, String) -> Void
    @State private var enlarged = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(asset.caption).font(serifFont(17, weight: .bold)).textSelection(.enabled)
                Spacer()
                if asset.jpeg != nil { Button("放大图表") { enlarged = true }.buttonStyle(FunButtonStyle(small: true)) }
                Button("Page \(asset.page)") { onEvidence(asset.page, asset.caption) }.buttonStyle(FunButtonStyle(small: true))
            }
            if let jpeg = asset.jpeg, let image = NSImage(data: jpeg) {
                Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
            }
            if let error = asset.error {
                DisclosureGroup("该图的视觉解读待核对 · 查看原因") {
                    Text(error).font(.system(size: 12)).foregroundColor(.gold).textSelection(.enabled)
                }
            }
        }
        .sheet(isPresented: $enlarged) {
            VStack(alignment: .trailing, spacing: 12) {
                Button("关闭") { enlarged = false }.buttonStyle(FunButtonStyle(small: true))
                if let jpeg = asset.jpeg, let image = NSImage(data: jpeg) {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Text(asset.caption).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(20).frame(minWidth: 900, minHeight: 650)
        }
    }
}
