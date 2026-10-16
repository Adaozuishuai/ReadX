import SwiftUI
import AppKit
import PDFKit

// MARK: - 可选中文本视图（自带「这里没懂」浮标）

final class SelectionTextView: NSTextView {
    var onAsk: ((String, String) -> Void)?
    private let pill = NSButton(title: "这里没懂", target: nil, action: nil)

    override init(frame frameRect: NSRect, textContainer: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: textContainer)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        pill.bezelStyle = .rounded
        pill.controlSize = .small
        pill.target = self
        pill.action = #selector(askTapped)
        pill.isHidden = true
        pill.toolTip = "结合上下文解释这句话"
        addSubview(pill)
        NotificationCenter.default.addObserver(self, selector: #selector(selectionChanged),
                                               name: NSTextView.didChangeSelectionNotification, object: self)
    }

    @objc private func selectionChanged() { updatePill() }

    override func layout() {
        super.layout()
        // 宽度始终贴合外层滚动容器（否则文本按超宽排版，右侧被裁掉）
        if !isHorizontallyResizable, let sv = enclosingScrollView {
            let w = sv.contentSize.width
            if abs(frame.width - w) > 0.5 { frame.size.width = w }
        }
        refreshLayout()
        updatePill()
    }

    /// 让视图高度跟随文本内容高度（否则在 SwiftUI 里会塌陷成零高度）
    func refreshLayout() {
        guard isVerticallyResizable, let container = textContainer, let lm = layoutManager else { return }
        lm.ensureLayout(for: container)
        let used = lm.usedRect(for: container)
        let need = used.height + textContainerInset.height * 2
        let minH = enclosingScrollView?.contentSize.height ?? 0
        let target = max(need, minH)
        if abs(frame.height - target) > 0.5 { frame.size.height = target }
    }

    private func updatePill() {
        let r = selectedRange()
        guard r.length >= 2, let window else { pill.isHidden = true; return }
        pill.sizeToFit()
        pill.isHidden = false
        let screenRect = firstRect(forCharacterRange: r, actualRange: nil)
        let local = convert(window.convertFromScreen(screenRect), from: nil)
        let pw = pill.frame.width, ph = pill.frame.height
        var py = local.maxY + 6
        if py + ph > bounds.height - 4 { py = max(4, local.minY - ph - 6) }
        var px = max(6, min(local.minX, bounds.width - pw - 10))
        if px.isNaN { px = 6 }
        pill.frame.origin = NSPoint(x: px, y: py)
    }

    @objc private func askTapped() {
        let r = selectedRange()
        guard r.length >= 2 else { return }
        let ns = string as NSString
        let s = ns.substring(with: r)
        // 上下文取选区前后各 400 字符，而不是恒为文档开头——选区在哪，上下文就在哪
        let lo = max(0, r.location - 400), hi = min(ns.length, r.location + r.length + 400)
        let ctx = ns.substring(with: NSRange(location: lo, length: hi - lo))
        onAsk?(s, ctx)
        pill.isHidden = true
    }
}

struct SelectableTextView: NSViewRepresentable {
    let attributed: NSAttributedString
    let onAsk: (String, String) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(containerSize: NSSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        let tv = SelectionTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 400), textContainer: container)
        storage.setAttributedString(attributed)
        tv.setSelectedRange(NSRange(location: 0, length: 0))
        tv.isSelectable = true
        tv.isEditable = false
        tv.drawsBackground = false
        tv.textContainerInset = NSSize(width: 8, height: 12)
        tv.minSize = NSSize(width: 0, height: 0)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.textContainer?.widthTracksTextView = true
        tv.autoresizingMask = [.width]
        tv.onAsk = onAsk
        let scroll = NSScrollView()
        scroll.documentView = tv
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        DispatchQueue.main.async {
            tv.refreshLayout()
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? SelectionTextView else { return }
        tv.onAsk = onAsk
        if tv.attributedString() != attributed {
            let sel = tv.selectedRange()
            tv.textStorage?.setAttributedString(attributed)
            if sel.location + sel.length <= (tv.string as NSString).length { tv.setSelectedRange(sel) }
        }
        tv.refreshLayout()
    }
}

// MARK: - 可提问 PDF 视图（自带「这里没懂」浮标）
// 第②步重写后左栏不再有可选中文本面板，选中提问的入口移到 PDF 阅读面板：
// 划选正文即出现浮标，点击后由助教结合上下文解释（复刻 SelectionTextView 的交互）。

final class AskablePDFView: PDFView {
    var onAsk: ((String, String) -> Void)?
    private let pill = NSButton(title: "这里没懂", target: nil, action: nil)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        pill.bezelStyle = .rounded
        pill.controlSize = .small
        pill.target = self
        pill.action = #selector(askTapped)
        pill.isHidden = true
        pill.toolTip = "结合上下文解释这句话"
        addSubview(pill)
        NotificationCenter.default.addObserver(self, selector: #selector(selectionChanged),
                                               name: .PDFViewSelectionChanged, object: self)
        // 翻页/滚动时选区在视图里的位置会变，浮标必须跟着重算
        NotificationCenter.default.addObserver(self, selector: #selector(selectionChanged),
                                               name: .PDFViewPageChanged, object: self)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func selectionChanged() { updatePill() }

    private func updatePill() {
        guard let sel = currentSelection, let text = sel.string,
              text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2,
              let page = sel.pages.first, window != nil else {
            pill.isHidden = true
            return
        }
        pill.sizeToFit()
        pill.isHidden = false
        // 选区在首页部分的页面坐标 → 视图坐标；浮标放选区上方，顶部放不下改到下方
        let viewRect = convert(sel.bounds(for: page), from: page)
        let pw = pill.frame.width, ph = pill.frame.height
        var py = viewRect.maxY + 6
        if py + ph > bounds.height - 4 { py = max(4, viewRect.minY - ph - 6) }
        var px = max(6, min(viewRect.minX, bounds.width - pw - 10))
        if px.isNaN { px = 6 }
        pill.frame.origin = NSPoint(x: px, y: py)
    }

    @objc private func askTapped() {
        guard let sel = currentSelection, let text = sel.string,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let pageText = sel.pages.first?.string ?? ""
        onAsk?(text, PDFSelectionContext.nearby(text, in: pageText))
        pill.isHidden = true
    }
}

/// 从页面文本中取选区前后的上下文，供「这里没懂」解释用。
/// PDFKit 的选区字符串与 page.string 的换行/连字符记法不完全一致，按前缀逐级缩短匹配；
/// 完全匹配不上时回退为选区本身，保证模型至少能看到被选中的句子。
enum PDFSelectionContext {
    static func nearby(_ selection: String, in pageText: String, radius: Int = 400) -> String {
        let nsPage = pageText as NSString
        let trimmed = selection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, nsPage.length > 0 else { return trimmed }
        var range = NSRange(location: NSNotFound, length: 0)
        for probe in [trimmed, String(trimmed.prefix(60)), String(trimmed.prefix(24))] where !probe.isEmpty {
            range = nsPage.range(of: probe)
            if range.location != NSNotFound { break }
        }
        guard range.location != NSNotFound else { return trimmed }
        let lo = max(0, range.location - radius)
        let hi = min(nsPage.length, range.location + range.length + radius)
        return nsPage.substring(with: NSRange(location: lo, length: hi - lo))
    }
}

// MARK: - 富文本构建（与笔记的 Markdown 子集对应）

enum RichText {
    static func serif(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: weight)
    }

    static func inline(_ s: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .textColor) -> NSAttributedString {
        var attrStr = AttributedString(s)
        if let parsed = try? AttributedString(
            markdown: s,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) { attrStr = parsed }
        let out = NSMutableAttributedString(attributedString: NSAttributedString(attrStr))
        let full = NSRange(location: 0, length: out.length)
        // AttributedString(markdown:) 把强调保留在 NSInlinePresentationIntent 上（实测：
        // 粗体 rawValue 2、斜体 1、等宽 4），转成 NSAttributedString 后不会变成 .font 特征。
        // 因此这里先把 intent 读出来，再按段套用字体——绝不能对整个 range 统一覆盖 .font，
        // 那会把唯一的样式来源抹掉（表现为 Step② 丢失粗体，与 Step① 不一致）。
        var runs: [(NSRange, Bool, Bool, Bool)] = []
        out.enumerateAttribute(NSAttributedString.Key("NSInlinePresentationIntent"), in: full) { value, range, _ in
            let raw = (value as? NSNumber)?.intValue ?? Int((value as? InlinePresentationIntent)?.rawValue ?? 0)
            runs.append((range, raw & 2 != 0, raw & 1 != 0, raw & 4 != 0))
        }
        out.addAttribute(.foregroundColor, value: color, range: full)
        guard !runs.isEmpty else {
            out.addAttribute(.font, value: serif(size, weight: weight), range: full)
            return out
        }
        for (range, bold, italic, mono) in runs {
            let base = serif(size, weight: bold ? .bold : weight)
            let f = italic ? NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask) : base
            out.addAttribute(.font, value: mono ? NSFont.monospacedSystemFont(ofSize: size - 1, weight: .regular) : f, range: range)
        }
        return out
    }

    static func fromMarkdown(_ src: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let blocks = Markdown.parse(src)
        let accentColor = NSColor(red: 108.0 / 255, green: 92.0 / 255, blue: 231.0 / 255, alpha: 1)
        for block in blocks {
            switch block {
            case .heading(let t, let level):
                out.append(inline(t, size: level <= 2 ? 16.5 : 15.5, weight: .semibold, color: accentColor))
            case .paragraph(let lines):
                for l in lines { out.append(inline(l + "\n", size: Typography.body)) }
            case .quote(let lines):
                for l in lines { out.append(inline(l + "\n", size: Typography.callout, color: .secondaryLabelColor)) }
            case .bullets(let items):
                for item in items {
                    out.append(NSAttributedString(string: "•  ", attributes: [.font: serif(Typography.body), .foregroundColor: accentColor]))
                    out.append(inline(item + "\n", size: Typography.body))
                }
            case .ordered(let items):
                for (i, item) in items.enumerated() {
                    out.append(NSAttributedString(string: "\(i + 1). ", attributes: [.font: serif(Typography.callout), .foregroundColor: NSColor.secondaryLabelColor]))
                    out.append(inline(item + "\n", size: Typography.body))
                }
            case .rule:
                out.append(NSAttributedString(string: String(repeating: "─", count: 32) + "\n",
                    attributes: [.font: NSFont.systemFont(ofSize: Typography.micro), .foregroundColor: NSColor.tertiaryLabelColor]))
            case .table(let table):
                // NSTextView 无法嵌入 SwiftUI 表格：用等宽对齐的纯文本回退，
                // 保留列对齐与可选中，不用竖线糊成一行。
                out.append(NSAttributedString(
                    string: table.plainText() + "\n",
                    attributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: Typography.caption, weight: .regular),
                        .foregroundColor: NSColor.labelColor,
                    ]
                ))
            case .mathBlock(let latex):
                // NSTextView 无法嵌入 SwiftUI 公式视图：保留原始 LaTeX 源码（可选中复制），
                // 排版后的公式在右侧 Markdown 面板展示。
                out.append(NSAttributedString(string: "〔公式 · LaTeX〕\n", attributes: [
                    .font: NSFont.systemFont(ofSize: Typography.micro), .foregroundColor: accentColor]))
                out.append(NSAttributedString(string: latex + "\n", attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: Typography.caption, weight: .regular),
                    .foregroundColor: NSColor.labelColor]))
            }
            out.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 6)]))
        }
        return out
    }
}

// MARK: - PDF（PDFKit 原生）

struct PDFKitView: NSViewRepresentable {
    let url: URL
    var page = 1
    var requestID = UUID()
    var excerpt = ""
    var onSelection: ((String, Int?) -> Void)? = nil
    var onAsk: ((String, String) -> Void)? = nil
    var onPage: ((Int, Int) -> Void)? = nil
    final class Coordinator {
        var requestID: UUID?
        var observer: NSObjectProtocol?
        var pageObserver: NSObjectProtocol?
        var onSelection: ((String, Int?) -> Void)?
        var onPage: ((Int, Int) -> Void)?
        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            if let pageObserver { NotificationCenter.default.removeObserver(pageObserver) }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> PDFView {
        let view = AskablePDFView(frame: .zero)
        view.autoScales = true; view.displayMode = .singlePageContinuous
        view.document = PDFDocument(url: url)
        view.onAsk = onAsk
        context.coordinator.onSelection = onSelection
        context.coordinator.onPage = onPage
        let coordinator = context.coordinator
        coordinator.observer = NotificationCenter.default.addObserver(forName: .PDFViewSelectionChanged, object: view, queue: .main) { [weak view, weak coordinator] _ in
            guard let view, let coordinator else { return }
            let selection = view.currentSelection
            let number = selection?.pages.first.flatMap { view.document?.index(for: $0) }.map { $0 + 1 }
            // Defer publication until outside SwiftUI's update cycle.
            DispatchQueue.main.async { coordinator.onSelection?(selection?.string ?? "", number) }
        }
        coordinator.pageObserver = NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak view, weak coordinator] _ in
            guard let view, let coordinator, let document = view.document else { return }
            let current = view.currentPage.flatMap { document.index(for: $0) }.map { $0 + 1 } ?? 1
            DispatchQueue.main.async { coordinator.onPage?(current, document.pageCount) }
        }
        return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        context.coordinator.onSelection = onSelection
        context.coordinator.onPage = onPage
        (view as? AskablePDFView)?.onAsk = onAsk
        if view.document?.documentURL != url { view.document = PDFDocument(url: url); context.coordinator.requestID = nil }
        guard context.coordinator.requestID != requestID else { return }
        context.coordinator.requestID = requestID
        let target = page, quote = excerpt
        DispatchQueue.main.async {
            if let document = view.document, let pdfPage = document.page(at: max(0, min(document.pageCount - 1, target - 1))) {
                view.go(to: pdfPage)
                view.highlightedSelections = nil
                if !quote.isEmpty, let selection = PDFLayout.selection(quote, page: pdfPage) {
                    selection.color = .systemYellow
                    view.highlightedSelections = [selection]
                    view.go(to: selection)
                    // Keep nearby table headers/paragraph context above the highlight.
                    let pageBounds = pdfPage.bounds(for: .cropBox)
                    let top = min(pageBounds.maxY, selection.bounds(for: pdfPage).maxY + 90)
                    view.go(to: PDFDestination(page: pdfPage, at: CGPoint(x: pageBounds.minX, y: top)))
                }
            }
        }
    }
}
