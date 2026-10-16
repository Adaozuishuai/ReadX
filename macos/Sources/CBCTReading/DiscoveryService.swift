import Foundation

// Small XML tree preserves nested titles/abstracts and decodes XML entities correctly.
final class XMLNode {
    let name: String
    let attributes: [String: String]
    var content = ""
    var children: [XMLNode] = []
    init(_ name: String, _ attributes: [String: String] = [:]) { self.name = name.components(separatedBy: ":").last!; self.attributes = attributes }
    var text: String { content.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines) }
    func child(_ name: String) -> XMLNode? { children.first { $0.name == name } }
    func descendants(_ name: String) -> [XMLNode] { children.flatMap { ($0.name == name ? [$0] : []) + $0.descendants(name) } }
}

final class PaperXMLParser: NSObject, XMLParserDelegate {
    private var stack: [XMLNode] = []
    private var root: XMLNode?
    static func parse(_ data: Data) throws -> XMLNode {
        let delegate = PaperXMLParser(), parser = XMLParser(data: data)
        parser.delegate = delegate
        parser.shouldResolveExternalEntities = false
        guard parser.parse(), let root = delegate.root else {
            throw parser.parserError ?? NSError(domain: "xml", code: 1, userInfo: [NSLocalizedDescriptionKey: "论文源返回了无效 XML"])
        }
        return root
    }
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        let node = XMLNode(name, attributes)
        stack.last?.children.append(node)
        if root == nil { root = node }
        stack.append(node)
    }
    func parser(_ parser: XMLParser, foundCharacters text: String) { for node in stack { node.content += text } }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) { _ = stack.popLast() }
}

enum DiscoveryService {
    static func url(_ base: String, _ parameters: [String: String]) -> URL {
        var components = URLComponents(string: base)!
        components.queryItems = parameters.keys.sorted().map { URLQueryItem(name: $0, value: parameters[$0]) }
        return components.url!
    }
    static func fetch(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("CBCTResearchCopilot/1.1 (personal research reader)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "discovery", code: 1, userInfo: [NSLocalizedDescriptionKey: "论文源暂时不可用（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)）"])
        }
        return data
    }
    // MARK: 期刊 / 顶会来源
    /// 目标来源与其在 Semantic Scholar venue 字段中的别名线索（全小写包含匹配，宁缺毋滥）。
    static let preferredVenues: [(label: String, cues: [String])] = [
        ("MICCAI", ["miccai", "medical image computing and computer-assisted intervention", "med image comput comput assist interv"]),
        ("CVPR", ["cvpr", "computer vision and pattern recognition"]),
        ("ICCV", ["iccv", "international conference on computer vision"]),
        ("ECCV", ["eccv", "european conference on computer vision"]),
        ("NeurIPS", ["neurips", "neural information processing systems"]),
        ("ICLR", ["iclr", "international conference on learning representations"]),
        ("AAAI", ["aaai", "association for the advancement of artificial intelligence"]),
        // Relevant medical-imaging meetings follow the core AI/CV conferences.
        ("ISBI", ["isbi", "international symposium on biomedical imaging"]),
        ("SPIE Medical Imaging", ["spie medical imaging", "medical imaging (spie)"]),
        ("TMI", ["ieee transactions on medical imaging", "trans. med. imaging", "trans med imaging"]),
        ("MIA", ["medical image analysis"]),
    ]
    static let conferenceLabels: Set<String> = ["MICCAI", "CVPR", "ICCV", "ECCV", "NeurIPS", "ICLR", "AAAI", "ISBI", "SPIE Medical Imaging"]

    /// venue 字符串 → 目标来源标签；不在目标清单的期刊/会议（含 arXiv 预印本、workshop）返回 nil。
    static func preferredVenue(_ venue: String) -> String? {
        let lower = venue.lowercased()
        guard !lower.isEmpty else { return nil }
        // Conference metadata often embeds the parent venue name in workshop
        // proceedings (for example "CVPR Workshops"). Do not rank those as
        // main-track papers.
        guard lower.range(of: #"\bworkshops?\b|\bwork in progress\b"#, options: .regularExpression) == nil else { return nil }
        return preferredVenues.first { $0.cues.contains { lower.contains($0) } }?.label
    }

    /// Keep accepted papers and unreviewed preprints in separate discovery feeds.
    /// arXiv's journal_ref is used only when it names a supported venue.
    static func arxiv() async throws -> [QueueEntry] {
        let endpoint = url("https://export.arxiv.org/api/query", [
            "search_query": "(all:CBCT OR all:\"cone beam\" OR all:\"cone-beam\" OR (all:CT AND all:\"sparse-view\")) AND (all:reconstruction OR all:tomography)",
            "max_results": "50", "sortBy": "submittedDate", "sortOrder": "descending",
        ])
        let tree = try PaperXMLParser.parse(await fetch(endpoint))
        guard tree.name == "feed", !tree.descendants("entry").contains(where: { $0.child("id")?.text.contains("api/errors") == true }) else { throw invalidSource() }
        return tree.descendants("entry").compactMap { entry in
            let raw = entry.child("id")?.text ?? ""
            guard raw.contains("arxiv.org/abs/"), let title = entry.child("title")?.text, !title.isEmpty else { return nil }
            let id = PaperIdentity.arxiv(raw)
            let journal = entry.child("journal_ref")?.text ?? ""
            let venue = preferredVenue(journal)
            var paper = QueueEntry(arxiv: id, title: title,
                                   authors: entry.descendants("author").compactMap { $0.child("name")?.text },
                                   venue: venue == nil ? "arXiv" : journal,
                                   pdfUrl: "https://arxiv.org/pdf/\(id)", abstract: entry.child("summary")?.text)
            paper.doi = entry.child("doi")?.text
            paper.source = venue ?? "arXiv 预印本"
            paper.published = String((entry.child("published")?.text ?? "").prefix(10))
            return paper
        }
    }

    /// 两个主题查询合并；venue 过滤在本地做（不依赖服务端参数，公共 API 对未知参数更严格）。
    static func semanticScholar() async throws -> [QueueEntry] {
        var papers: [QueueEntry] = []
        var failures: [String] = []
        do { papers += try await semanticScholar(query: "cone-beam CT reconstruction") }
        catch { failures.append(error.localizedDescription) }
        try await Task.sleep(nanoseconds: 1_500_000_000)   // 公共限速池礼貌间隔
        do { papers += try await semanticScholar(query: "sparse-view CT reconstruction") }
        catch { failures.append(error.localizedDescription) }
        if !papers.isEmpty { return PaperIdentity.deduplicate(papers) }
        do { return try await crossref() }
        catch {
            let details = (failures + ["Crossref: \(error.localizedDescription)"]).joined(separator: "；")
            throw NSError(domain: "discovery", code: 1, userInfo: [NSLocalizedDescriptionKey: "顶会检索源暂时不可用：\(details)"])
        }
    }

    private static func semanticScholar(query: String) async throws -> [QueueEntry] {
        let endpoint = url("https://api.semanticscholar.org/graph/v1/paper/search", [
            "query": query,
            "fields": "title,abstract,year,venue,publicationDate,authors,externalIds,openAccessPdf",
            "limit": "100",
        ])
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 30
        request.setValue("CBCTResearchCopilot/1.1 (personal research reader)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 429 {
            throw NSError(domain: "discovery", code: 429, userInfo: [NSLocalizedDescriptionKey: "Semantic Scholar 公共限速已满，请几分钟后再刷新"])
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "discovery", code: 1, userInfo: [NSLocalizedDescriptionKey: "Semantic Scholar 暂时不可用（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)）"])
        }
        return try parseSemanticScholar(data)
    }

    struct S2SearchResponse: Decodable { var data: [S2Paper] = [] }
    struct S2Paper: Decodable {
        var paperId: String?
        var title: String?
        var abstract: String?
        var venue: String?
        var year: Int?
        var publicationDate: String?
        var authors: [S2Author]?
        var externalIds: S2ExternalIDs?
        var openAccessPdf: S2OpenAccessPDF?
    }
    struct S2Author: Decodable { var name: String? }
    struct S2ExternalIDs: Decodable { var DOI: String? }
    struct S2OpenAccessPDF: Decodable { var url: String? }

    static func parseSemanticScholar(_ data: Data) throws -> [QueueEntry] {
        let response = try JSONDecoder().decode(S2SearchResponse.self, from: data)
        var seen = Set<String>()
        var out: [QueueEntry] = []
        for paper in response.data {
            guard let title = paper.title, !title.isEmpty,
                  let label = preferredVenue(paper.venue ?? "") else { continue }
            let paperID = paper.paperId ?? title
            guard seen.insert(paperID).inserted else { continue }
            var entry = QueueEntry(id: "s2-" + paperID, title: title,
                                   authors: (paper.authors ?? []).compactMap(\.name),
                                   venue: paper.venue ?? "",
                                   pdfUrl: paper.openAccessPdf?.url,
                                   abstract: paper.abstract)
            entry.source = label
            entry.doi = paper.externalIds?.DOI
            entry.published = paper.publicationDate ?? paper.year.map { String($0) }
            out.append(entry)
        }
        return out
    }

    // Semantic Scholar can impose short public rate limits. Crossref is a
    // metadata-only fallback; venue names are still checked against the same
    // allowlist so unrelated proceedings do not enter the conference feed.
    static func crossref() async throws -> [QueueEntry] {
        var papers: [QueueEntry] = []
        let containers: [(String, String)] = [
            ("MICCAI", "Medical Image Computing and Computer Assisted Intervention"),
            ("CVPR", "IEEE/CVF Conference on Computer Vision and Pattern Recognition"),
            ("ICCV", "International Conference on Computer Vision"),
            ("ECCV", "European Conference on Computer Vision"),
            ("NeurIPS", "Advances in Neural Information Processing Systems"),
            ("ICLR", "International Conference on Learning Representations"),
            ("AAAI", "AAAI Conference on Artificial Intelligence"),
            ("ISBI", "IEEE International Symposium on Biomedical Imaging"),
            ("SPIE Medical Imaging", "Medical Imaging"),
            ("TMI", "IEEE Transactions on Medical Imaging"),
            ("MIA", "Medical Image Analysis"),
        ]
        let recent = Calendar(identifier: .gregorian).date(byAdding: .year, value: -5, to: Date()) ?? Date()
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        var failures: [String] = []
        for (index, (_, container)) in containers.enumerated() {
            if index > 0 { try await Task.sleep(nanoseconds: 250_000_000) }
            let endpoint = url("https://api.crossref.org/works", [
                "query.container-title": container, "query": "cone beam CT reconstruction sparse-view",
                "rows": "30", "select": "DOI,title,container-title,author,abstract,published,issued,link,type",
                "filter": "from-pub-date:\(formatter.string(from: recent))",
            ])
            do { papers += try parseCrossref(await fetch(endpoint)) }
            catch { failures.append("\(container): \(error.localizedDescription)") }
        }
        if papers.isEmpty, !failures.isEmpty {
            throw NSError(domain: "discovery", code: 1, userInfo: [NSLocalizedDescriptionKey: failures.joined(separator: "；")])
        }
        return PaperIdentity.deduplicate(papers)
    }

    struct CrossrefResponse: Decodable { var message: CrossrefMessage }
    struct CrossrefMessage: Decodable { var items: [CrossrefWork] = [] }
    struct CrossrefWork: Decodable {
        var DOI: String?
        var title: [String]?
        var containerTitle: [String]?
        var author: [CrossrefAuthor]?
        var abstract: String?
        var published: CrossrefDate?
        var issued: CrossrefDate?
        var link: [CrossrefLink]?
        enum CodingKeys: String, CodingKey {
            case DOI, title, author, abstract, published, issued, link
            case containerTitle = "container-title"
        }
    }
    struct CrossrefAuthor: Decodable { var given: String?; var family: String? }
    struct CrossrefDate: Decodable { var dateParts: [[Int]]?; enum CodingKeys: String, CodingKey { case dateParts = "date-parts" } }
    struct CrossrefLink: Decodable { var URL: String?; var contentType: String?; enum CodingKeys: String, CodingKey { case URL; case contentType = "content-type" } }

    static func parseCrossref(_ data: Data) throws -> [QueueEntry] {
        let response = try JSONDecoder().decode(CrossrefResponse.self, from: data)
        return response.message.items.compactMap { work in
            guard let title = work.title?.first?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
                  let venue = work.containerTitle?.first, let label = preferredVenue(venue),
                  let doi = work.DOI, !doi.isEmpty else { return nil }
            let dateParts = work.published?.dateParts?.first ?? work.issued?.dateParts?.first ?? []
            let published = dateParts.isEmpty ? nil : dateParts.map(String.init).joined(separator: "-")
            let abstract = work.abstract?.replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var entry = QueueEntry(id: "crossref-" + doi.lowercased(), title: title,
                                   authors: (work.author ?? []).compactMap { author in
                                       let name = [author.given, author.family].compactMap { $0 }.joined(separator: " ")
                                       return name.isEmpty ? nil : name
                                   }, venue: venue,
                                   pdfUrl: work.link?.first(where: { $0.contentType?.lowercased().contains("pdf") == true })?.URL,
                                   abstract: abstract?.isEmpty == true ? nil : abstract)
            entry.source = label
            entry.doi = doi
            entry.published = published
            return entry
        }
    }
    static func pubmed() async throws -> [QueueEntry] {
        let search = url("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", ["db": "pubmed", "term": "(CBCT[Title/Abstract] OR cone-beam[Title/Abstract] OR cone beam[Title/Abstract]) AND reconstruction[Title/Abstract]", "retmax": "30", "sort": "pub_date", "retmode": "xml", "tool": "cbct_research_copilot"])
        let tree = try PaperXMLParser.parse(await fetch(search))
        guard tree.name == "eSearchResult", tree.descendants("ERROR").isEmpty else { throw invalidSource() }
        let ids = tree.descendants("Id").map(\.text)
        guard !ids.isEmpty else { return [] }
        try await Task.sleep(nanoseconds: 400_000_000)
        let endpoint = url("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", ["db": "pubmed", "id": ids.joined(separator: ","), "retmode": "xml", "tool": "cbct_research_copilot"])
        return try parsePubmed(await fetch(endpoint))
    }
    static func parsePubmed(_ data: Data) throws -> [QueueEntry] {
        let tree = try PaperXMLParser.parse(data)
        guard tree.name == "PubmedArticleSet" else { throw invalidSource() }
        return tree.descendants("PubmedArticle").compactMap { node in
            guard let pmid = node.descendants("PMID").first?.text, let article = node.descendants("Article").first,
                  let title = article.child("ArticleTitle")?.text else { return nil }
            let authors = article.descendants("Author").map { author in
                [author.child("ForeName")?.text, author.child("LastName")?.text, author.child("CollectiveName")?.text].compactMap { $0 }.joined(separator: " ")
            }.filter { !$0.isEmpty }
            let date = article.descendants("PubDate").first
            let published = [date?.child("Year")?.text, date?.child("Month")?.text, date?.child("Day")?.text].compactMap { $0 }.joined(separator: "-")
            var paper = QueueEntry(id: "pubmed-\(pmid)", title: title, authors: authors, venue: article.child("Journal")?.child("Title")?.text ?? "PubMed", abstract: article.descendants("AbstractText").map { (($0.attributes["Label"].map { $0 + ": " }) ?? "") + $0.text }.joined(separator: "\n"))
            paper.source = "PubMed"; paper.published = published.isEmpty ? date?.child("MedlineDate")?.text : published
            paper.doi = node.descendants("ArticleId").first { $0.attributes["IdType"] == "doi" }?.text
            return paper
        }
    }
    static func invalidSource() -> NSError { NSError(domain: "source", code: 1, userInfo: [NSLocalizedDescriptionKey: "论文源返回了意外的数据格式"] ) }
}
