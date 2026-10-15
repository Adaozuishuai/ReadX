import Foundation
import CoreGraphics
import ImageIO
import Vision

// MARK: - 架构图 / 模型结构图解析
//
// 链路：定位图中区域（图题启发式）→ OCR 取图中文字 → 视觉模型输出模块与连接的 JSON
// → 校验（标签必须在图中 OCR 文本里出现，防止凭空编造）→ 分层布局渲染。
// 任一步失败都只保留目标图块裁剪与图题；没有可靠裁剪时不发送/展示整页，绝不推测结构。

struct FigureNode: Codable, Identifiable, Equatable {
    var id: String
    var label: String
    /// 模块类型：input / module / loss / output / data
    var kind: String = "module"
    var layer: Int? = nil      // 模型给出的层级；缺失时由布局算法计算
}

struct FigureEdge: Codable, Equatable {
    var from: String
    var to: String
    var label: String? = nil
}

/// A model-proposed subfigure crop. Coordinates are normalized against the
/// caption-bounded figure, with origin at its top-left corner.
struct FigureSubpanel: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var nodes: [FigureNode]
    var edges: [FigureEdge]
    var ocrText: String = ""
    var jpeg: Data? = nil
    var dropped: [String] = []
    var note: String = ""

    var normalizedRect: CGRect { CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height)) }

    private enum CodingKeys: String, CodingKey { case id, label, x, y, width, height, nodes, edges, ocrText, jpeg, dropped, note }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? ""
        label = try values.decodeIfPresent(String.self, forKey: .label) ?? ""
        x = try values.decodeIfPresent(Double.self, forKey: .x) ?? -1
        y = try values.decodeIfPresent(Double.self, forKey: .y) ?? -1
        width = try values.decodeIfPresent(Double.self, forKey: .width) ?? 0
        height = try values.decodeIfPresent(Double.self, forKey: .height) ?? 0
        nodes = try values.decodeIfPresent([FigureNode].self, forKey: .nodes) ?? []
        edges = try values.decodeIfPresent([FigureEdge].self, forKey: .edges) ?? []
        ocrText = try values.decodeIfPresent(String.self, forKey: .ocrText) ?? ""
        jpeg = try values.decodeIfPresent(Data.self, forKey: .jpeg)
        dropped = try values.decodeIfPresent([String].self, forKey: .dropped) ?? []
        note = try values.decodeIfPresent(String.self, forKey: .note) ?? ""
    }
}

struct FigureAnalysis: Codable, Equatable {
    var page: Int
    var title: String
    var nodes: [FigureNode]
    var edges: [FigureEdge]
    /// 未通过校验（标签未出现在图中 OCR 文本）而被剔除的节点标签
    var dropped: [String] = []
    var note: String = ""
    var panels: [FigureSubpanel] = []

    static func decode(_ raw: String) throws -> Self {
        let text = JSONExtract.object(from: raw)
        return try JSONDecoder().decode(Self.self, from: Data(text.utf8))
    }

    /// 校验并清洗：节点标签必须在图中 OCR 文本出现（宽松匹配：忽略空白与大小写）。
    /// 边引用的节点必须存在。返回可展示的分析；节点不足 2 个时返回 nil（调用方降级为原图）。
    func validated(against ocrText: String) -> FigureAnalysis {
        let normalized = Evidence.normalized(ocrText)
        var kept: [FigureNode] = []
        var droppedLabels: [String] = []
        var seenIDs = Set<String>()
        for node in nodes {
            let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !node.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !label.isEmpty, seenIDs.insert(node.id).inserted else {
                droppedLabels.append(label.isEmpty ? "(空标签或重复/空 ID)" : label + "（重复/空 ID）")
                continue
            }
            if normalized.contains(Evidence.normalized(label)) { kept.append(node) }
            else { droppedLabels.append(label) }
        }
        let ids = Set(kept.map(\.id))
        let edges = self.edges.filter { ids.contains($0.from) && ids.contains($0.to) && $0.from != $0.to }
        // 去掉孤立节点（没有任何连接）会让图更干净，但也可能丢掉输入/输出块；
        // 这里保留，因为它们往往正是图的边界。
        var result = self
        result.nodes = kept
        result.edges = edges
        result.dropped = droppedLabels
        var keptPanels: [FigureSubpanel] = []
        for var panel in panels {
            let rect = panel.normalizedRect
            guard !panel.id.isEmpty, !panel.label.isEmpty,
                  rect.minX >= 0, rect.minY >= 0, rect.maxX <= 1.001, rect.maxY <= 1.001,
                  rect.width >= 0.08, rect.height >= 0.08,
                  !panel.ocrText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                droppedLabels.append("子图 \(panel.label)：裁剪框或局部 OCR 无效")
                continue
            }
            let panelOCR = Evidence.normalized(panel.ocrText)
            let marker = NSRegularExpression.escapedPattern(for: panel.id)
            let markerPattern = "(?i)^\\s*\\(?\(marker)\\)?[.):]?\\s*$"
            let markerFound = panel.ocrText.components(separatedBy: .newlines).contains {
                $0.range(of: markerPattern, options: .regularExpression) != nil
            } || panelOCR.contains(Evidence.normalized(panel.label))
            guard markerFound else {
                droppedLabels.append("子图 \(panel.label)：图内标记未被该裁剪 OCR 核验")
                continue
            }
            var panelNodes: [FigureNode] = []
            var panelDropped: [String] = []
            var panelIDs = Set<String>()
            for node in panel.nodes {
                let label = node.label.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !node.id.isEmpty, !label.isEmpty, panelIDs.insert(node.id).inserted,
                      panelOCR.contains(Evidence.normalized(label)) else {
                    panelDropped.append(label.isEmpty ? "空标签/重复 ID" : label)
                    droppedLabels.append("子图 \(panel.label)：模块「\(label)」未被局部 OCR 核验")
                    continue
                }
                panelNodes.append(node)
            }
            let panelNodeIDs = Set(panelNodes.map(\.id))
            panel.nodes = panelNodes
            panel.edges = panel.edges.filter { panelNodeIDs.contains($0.from) && panelNodeIDs.contains($0.to) && $0.from != $0.to }
            panel.dropped.append(contentsOf: panelDropped)
            if !panelDropped.isEmpty {
                panel.note = "已剔除本子图 OCR 未核实的模块：" + panelDropped.joined(separator: "、")
            }
            keptPanels.append(panel)
        }
        result.panels = keptPanels
        if !droppedLabels.isEmpty {
            result.note = "已剔除 \(droppedLabels.count) 个未通过图内 OCR 核验的标签或子图：" + droppedLabels.joined(separator: "、")
        }
        return result
    }

    var isUsable: Bool {
        (nodes.count >= 2 && !edges.isEmpty) || panels.contains { $0.nodes.count >= 2 && !$0.edges.isEmpty }
    }
}

extension FigureAnalysis {
    /// The model only supplies the figure fields; validation metadata is generated locally.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        page = try values.decodeIfPresent(Int.self, forKey: .page) ?? 0
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? ""
        nodes = try values.decode([FigureNode].self, forKey: .nodes)
        edges = try values.decode([FigureEdge].self, forKey: .edges)
        dropped = try values.decodeIfPresent([String].self, forKey: .dropped) ?? []
        note = try values.decodeIfPresent(String.self, forKey: .note) ?? ""
        panels = try values.decodeIfPresent([FigureSubpanel].self, forKey: .panels) ?? []
    }
}

/// Re-crops model-proposed subfigures from the retained whole figure and runs
/// Vision OCR on each crop before validating its module labels.
enum FigurePanelCrop {
    static func attachOCRAndImages(to analysis: FigureAnalysis, figureJPEG: Data) -> FigureAnalysis {
        guard !analysis.panels.isEmpty,
              let source = CGImageSourceCreateWithData(figureJPEG as CFData, nil),
              let full = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return analysis }
        var result = analysis
        result.panels = analysis.panels.compactMap { input in
            let box = input.normalizedRect
            guard box.minX >= 0, box.minY >= 0, box.maxX <= 1.001, box.maxY <= 1.001,
                  box.width >= 0.08, box.height >= 0.08 else { return nil }
            let x = max(0, Int((box.minX * Double(full.width)).rounded(.down)))
            let y = max(0, Int((box.minY * Double(full.height)).rounded(.down)))
            let right = min(full.width, Int((box.maxX * Double(full.width)).rounded(.up)))
            let bottom = min(full.height, Int((box.maxY * Double(full.height)).rounded(.up)))
            guard right > x, bottom > y,
                  let crop = full.cropping(to: CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(right - x), height: CGFloat(bottom - y))) else { return nil }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            do { try VNImageRequestHandler(cgImage: crop, options: [:]).perform([request]) }
            catch { return nil }
            var panel = input
            panel.ocrText = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, crop, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            panel.jpeg = data as Data
            return panel
        }
        return result
    }
}

// MARK: - 分层布局（纯函数，便于回归测试）

struct FigureLayout {
    struct Placed: Equatable {
        var id: String
        var rect: CGRect
        var label: String
        var kind: String
        var layer: Int
    }
    struct Arrow: Equatable {
        var from: CGPoint
        var to: CGPoint
        var label: String?
    }
    struct Result: Equatable {
        var placed: [Placed]
        var arrows: [Arrow]
        var layerCount: Int
    }

    /// 计算层级：优先用模型给出的 layer，缺失时用「最长路径」分层（DAG 上做拓扑松弛）。
    static func layers(nodes: [FigureNode], edges: [FigureEdge]) -> [String: Int] {
        var depth: [String: Int] = [:]
        for node in nodes { depth[node.id] = node.layer ?? 0 }
        // 迭代松弛：有环时最多迭代 nodes.count 次即停，保证终止
        for _ in 0..<max(1, nodes.count) {
            var changed = false
            for edge in edges {
                let current = depth[edge.to] ?? 0
                let candidate = (depth[edge.from] ?? 0) + 1
                if candidate > current { depth[edge.to] = candidate; changed = true }
            }
            if !changed { break }
        }
        return depth
    }

    /// 在给定画布内排布节点：层级沿主轴排列，层内节点沿副轴均分。
    /// - Parameter vertical: true 时层级自上而下（适合窄容器），false 时自左而右（适合宽容器）。
    static func layout(nodes: [FigureNode], edges: [FigureEdge], canvas: CGSize, vertical: Bool) -> Result {
        guard !nodes.isEmpty, canvas.width > 40, canvas.height > 40 else {
            return Result(placed: [], arrows: [], layerCount: 0)
        }
        let depth = layers(nodes: nodes, edges: edges)
        let grouped = Dictionary(grouping: nodes) { depth[$0.id] ?? 0 }
        let layerKeys = grouped.keys.sorted()
        let padding: CGFloat = 12
        let gap: CGFloat = 10

        var placed: [Placed] = []
        let layerSpan: CGFloat
        let crossSpan: CGFloat
        if vertical {
            layerSpan = canvas.height - padding * 2
            crossSpan = canvas.width - padding * 2
        } else {
            layerSpan = canvas.width - padding * 2
            crossSpan = canvas.height - padding * 2
        }
        let layerSize = max(40, layerSpan / CGFloat(max(1, layerKeys.count)))

        for (index, key) in layerKeys.enumerated() {
            let items = grouped[key] ?? []
            let offset = padding + CGFloat(index) * layerSize
            let itemSize = max(28, crossSpan / CGFloat(max(1, items.count)) - gap)
            for (i, node) in items.enumerated() {
                let cross = padding + CGFloat(i) * (itemSize + gap)
                let rect = vertical
                    ? CGRect(x: cross, y: offset, width: itemSize, height: min(layerSize - gap, 62))
                    : CGRect(x: offset, y: cross, width: min(layerSize - gap, 132), height: min(itemSize, 54))
                placed.append(Placed(id: node.id, rect: rect, label: node.label, kind: node.kind, layer: key))
            }
        }

        var arrows: [Arrow] = []
        // 防御非法/重复 ID：分析校验通常已清洗，但布局纯函数也应能安全处理外部输入。
        let byID = placed.reduce(into: [String: Placed]()) { result, node in
            if result[node.id] == nil { result[node.id] = node }
        }
        for edge in edges {
            guard let a = byID[edge.from], let b = byID[edge.to] else { continue }
            let from = vertical ? CGPoint(x: a.rect.midX, y: a.rect.maxY) : CGPoint(x: a.rect.maxX, y: a.rect.midY)
            let to = vertical ? CGPoint(x: b.rect.midX, y: b.rect.minY) : CGPoint(x: b.rect.minX, y: b.rect.midY)
            arrows.append(Arrow(from: from, to: to, label: edge.label))
        }
        return Result(placed: placed, arrows: arrows, layerCount: layerKeys.count)
    }
}
