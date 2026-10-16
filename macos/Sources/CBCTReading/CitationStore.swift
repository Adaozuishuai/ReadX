import Foundation
import AppKit

// 引用导出的 Store 层包装（PRD 4.13 / 8.3）。
// 纯逻辑在 CitationExport 里，这里只负责文件面板与错误上报。

extension Store {
    /// 导出当前论文库（或已选对比项）为标准引用格式。
    /// - Parameters:
    ///   - format: "bibtex" 或 "ris"
    ///   - papers: 为空时导出整个论文库
    @discardableResult
    func exportCitations(_ papers: [QueueEntry], format: String) -> String? {
        let list = papers.isEmpty ? allPapers : papers
        guard !list.isEmpty else { dataError = "没有可导出的论文。"; return nil }
        let ext = format == "ris" ? "ris" : "bib"
        let text = format == "ris" ? CitationExport.ris(list) : CitationExport.bibtex(list)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            dataError = "引用内容为空，未导出。"; return nil
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = CitationExport.suggestedFilename(list, ext: ext, today: Self.nowISO())
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            showToast("已导出 \(list.count) 篇引用（\(ext.uppercased())）")
            return url.path
        } catch {
            dataError = "导出引用失败：\(error.localizedDescription)"
            return nil
        }
    }

    /// 单篇导出（论文库卡片上用）。
    @discardableResult
    func exportCitation(for paper: QueueEntry, format: String) -> String? {
        exportCitations([paper], format: format)
    }
}
