import SwiftUI

struct FunWorkspace: View {
    @ObservedObject var store: Store
    @State private var showConfig = false
    let tabs: [(String, String, Color)] = [("Today", "今日", .funYellow), ("Library", "论文库", .tealSoft), ("Topics", "主题", .accentSoft), ("Ideas", "想法", .funPink)]
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { store.workspacePage = "Today" } label: {
                    HStack(spacing: 10) { FunFace().frame(width: 36, height: 36); Text("CBCT Daily").font(.system(size: 22, weight: .heavy)).foregroundColor(.ink) }
                }.buttonStyle(.plain).accessibilityLabel("CBCT Daily · 首页")
                Spacer(minLength: 8)
                ForEach(tabs, id: \.0) { key, label, color in
                    Button { store.workspaceTopic = nil; store.workspacePage = key } label: {
                        Text(label).font(.system(size: 12, weight: .bold)).padding(.horizontal, 12).frame(height: FunLayout.controlHeight)
                            .background(Capsule().fill(color)).overlay(Capsule().stroke(Color.ink, lineWidth: store.workspacePage == key ? 1.8 : 0.6))
                    }.buttonStyle(.plain).accessibilityLabel(label).help(["Today": "今日发现", "Library": "论文库", "Topics": "研究主题", "Ideas": "研究想法"][key] ?? label)
                }
                Spacer(minLength: 4)
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                    TextField("搜索论文…", text: $store.workspaceSearch).textFieldStyle(.plain).onSubmit { store.workspaceTopic = nil; store.workspacePage = "Library" }
                }.font(.system(size: 12)).padding(.horizontal, 12).frame(width: 180, height: FunLayout.controlHeight).background(RoundedRectangle(cornerRadius: 14).fill(Color(hex: 0xF7F7F7))).overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.ink, lineWidth: 1.3))
                Menu {
                    Button("论文对比") { store.workspacePage = "Compare" }
                    Button("知识地图") { store.workspacePage = "Map" }
                    Divider()
                    Button("导入论文 PDF") { store.importPDF() }
                    Button("导出研究资产") { store.exportResearch() }
                    Button("AI 助教设置") { showConfig = true }
                } label: { Image(systemName: "ellipsis").font(.system(size: 16, weight: .bold)) }.menuStyle(.borderlessButton).frame(width: 28).help("对比、导入、导出与设置")
                Button { store.workspacePage = "Profile" } label: { Image(systemName: "person.fill").font(.system(size: 13)).frame(width: 40, height: 40).background(Circle().fill(Color(hex: 0xFFD166))).overlay(Circle().stroke(Color.ink, lineWidth: 1.4)) }.buttonStyle(.plain).accessibilityLabel("研究画像")
            }.padding(.horizontal, 16).frame(height: 80).background(RoundedRectangle(cornerRadius: 24).fill(.white)).overlay(RoundedRectangle(cornerRadius: 24).stroke(Color.ink, lineWidth: 1.5)).shadow(color: .ink.opacity(0.05), radius: 12, y: 5).padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 32)
            if let error = store.dataError { HStack { Text(error).font(.system(size: 12)); Spacer(); Button("关闭") { store.dataError = nil }.buttonStyle(FunButtonStyle(small: true)) }.padding(12).background(Color.funPink) }
            Group {
                switch store.workspacePage {
                case "Library": LibraryWorkspace(store: store)
                case "Profile": ProfileWorkspace(store: store)
                case "Compare": CompareWorkspace(store: store)
                case "Ideas": IdeasWorkspace(store: store)
                case "Topics", "Map": TopicMapWorkspace(store: store)
                default: FunHome(store: store)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.padding(16).background(FunBackground()).overlay(RoundedRectangle(cornerRadius: 30).stroke(Color.ink, lineWidth: 1.5).padding(16)).sheet(isPresented: $showConfig) { ConfigSheet(store: store) }
    }
}

enum TopicNavigation {
    static let explorationTopic = "领域探索"
    static func matches(_ paper: QueueEntry, topic: String) -> Bool {
        let text = ((paper.title ?? "") + " " + (paper.abstract ?? "")).lowercased()
        return (ResearchProfile.keywords[topic] ?? [topic.lowercased()]).contains(where: text.contains)
    }
    @MainActor static func topics(_ store: Store) -> [String] { store.profile.topics.filter { $0.value > 0 }.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key) }
    static func matchesLibraryFilter(_ paper: QueueEntry, topic: String?, followedTopics: [String]) -> Bool {
        guard let topic else { return true }
        if topic == explorationTopic { return !followedTopics.contains { matches(paper, topic: $0) } }
        return matches(paper, topic: topic)
    }
    /// 主题流分组（PRD 5.1 Topic Stream）：每篇归入权重最高的匹配主题，都不匹配的进「领域探索」。
    /// 纯函数，便于回归测试。topics 需按权重从高到低传入。
    static func grouped(_ papers: [RankedPaper], topics: [String]) -> [(String, [RankedPaper])] {
        var groups: [(String, [RankedPaper])] = topics.map { ($0, []) }
        var rest: [RankedPaper] = []
        for ranked in papers {
            if let topic = topics.first(where: { matches(ranked.paper, topic: $0) }),
               let index = groups.firstIndex(where: { $0.0 == topic }) {
                groups[index].1.append(ranked)
            } else { rest.append(ranked) }
        }
        if !rest.isEmpty { groups.append((explorationTopic, rest)) }
        return groups.filter { !$0.1.isEmpty }
    }
}

struct FunHome: View {
    @ObservedObject var store: Store
    var unreadCount: Int { store.savedPapers.filter { [.unread, .later, .reading].contains(store.state($0.key).status) }.count }
    var readCount: Int { store.savedPapers.filter { store.state($0.key).status == .read }.count }
    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    let columns = FunLayout.Columns(width: geo.size.width - 32)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("读懂一篇 CBCT 论文。").font(.system(size: 30, weight: .heavy))
                        Text("连接一个新想法。").font(.system(size: 30, weight: .heavy)).foregroundColor(.accent)
                        HStack(spacing: 10) {
                            Text(Store.nowISO()).font(.system(size: 12)).foregroundColor(.inkSoft)
                            Text("待读 \(unreadCount) · 已读 \(readCount) · 连续 \(store.streak) 天").font(.system(size: 12, weight: .semibold)).foregroundColor(.teal)
                        }.padding(.top, 4)
                        HStack(spacing: 12) {
                            Button("开始今天的精读") { if let today = store.today { store.openReader(today) } else { store.workspacePage = "Library" } }.buttonStyle(FunButtonStyle(primary: true))
                            Button("打开知识地图") { store.workspacePage = "Map" }.buttonStyle(FunButtonStyle())
                        }.padding(.top, 12)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    HStack(alignment: .top, spacing: FunLayout.gap) {
                        AdventureCard(store: store).frame(width: columns.adventure)
                        VStack(spacing: FunLayout.gap) { StreakGardenCard(store: store); TopicGardenCard(store: store) }.frame(width: columns.middle)
                        PlaygroundCard(store: store).frame(width: columns.knowledge)
                    }.frame(height: FunLayout.dashboardHeight)
                    HStack {
                        Text("为你推荐").font(.system(size: 20, weight: .heavy)); Spacer()
                        Text("主题 · 方法 · 数据集 · 阅读反馈").font(.system(size: 11)).foregroundColor(.inkSoft)
                        Button(store.discoveryBusy ? "正在发现…" : "刷新论文") { Task { await store.refreshDiscovery(force: true) } }.buttonStyle(FunButtonStyle()).disabled(store.discoveryBusy)
                    }.padding(.top, 8)
                    let unread = store.rankedPapers.filter { store.state($0.id).status != .read }
                    let preprint: (RankedPaper) -> Bool = { ($0.paper.source ?? "").localizedCaseInsensitiveContains("arxiv") }
                    let conferenceSources: Set<String> = ["MICCAI", "CVPR", "ICCV", "ECCV", "NeurIPS", "ICLR", "AAAI"]
                    let medicalMeetingSources: Set<String> = ["ISBI", "SPIE Medical Imaging"]
                    let priority: (RankedPaper) -> Int = { paper in
                        let source = paper.paper.source ?? ""
                        if conferenceSources.contains(source) { return 0 }
                        if medicalMeetingSources.contains(source) { return 1 }
                        if source == "PubMed" { return 3 }
                        return 2
                    }
                    let mainFeed = unread.filter { !preprint($0) }.sorted {
                        priority($0) == priority($1) ? $0.score > $1.score : priority($0) < priority($1)
                    }
                    let picks = Array(mainFeed.filter { $0.matchesProfile }.prefix(5))
                    if picks.isEmpty { FunPanel { Text("暂无待读推荐。刷新论文，或从右上角导入自己的 PDF。").foregroundColor(.inkSoft) } }
                    ForEach(picks) { pick in PaperCard(store: store, ranked: pick) }
                    if let exploration = mainFeed.first(where: { !$0.matchesProfile }) { Text("领域探索").font(.system(size: 18, weight: .bold)); PaperCard(store: store, ranked: exploration) }
                    // 每日摘要（PRD 5.1 Daily Brief）：今日新增按首见日期计数，来源分开统计；
                    // 早期论文的首见日期以首次抓取日回填，口径在此标注。
                    let todayNew = store.todayNewPapers
                    let todayPreprints = store.todayNewPreprints
                    if !todayNew.isEmpty || !todayPreprints.isEmpty {
                        let venueCount = todayNew.filter { $0.source != "PubMed" }.count
                        let pubmedCount = todayNew.count - venueCount
                        FunPanel(color: .funYellow) {
                            Text("今日新增：正式期刊/会议 \(venueCount) · PubMed \(pubmedCount) · 预印本 \(todayPreprints.count)").font(.system(size: 14, weight: .heavy))
                            Text("顶会与期刊进入主推荐；arXiv 预印本独立展示。按首次出现日期统计，旧缓存回填日期不代表发表日。").font(.system(size: 10)).foregroundColor(.inkSoft)
                        }
                    }
                    let preprintPicks = Array(unread.filter(preprint).prefix(5))
                    if !preprintPicks.isEmpty {
                        Text("预印本 · 独立入口（尚未经过正式评审）").font(.system(size: 18, weight: .bold)).padding(.top, 8)
                        ForEach(preprintPicks) { PaperCard(store: store, ranked: $0) }
                    }
                    // 主题流（PRD 5.1 Topic Stream）：按画像主题分组浏览待读论文
                    let groups = TopicNavigation.grouped(unread, topics: TopicNavigation.topics(store))
                    if !groups.isEmpty {
                        Text("按主题浏览").font(.system(size: 20, weight: .heavy)).padding(.top, 8)
                        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                            VStack(alignment: .leading, spacing: 10) {
                                HStack {
                                    Text(group.0).font(.system(size: 17, weight: .bold))
                                    Text("\(group.1.count) 篇").font(.system(size: 12)).foregroundColor(.inkSoft)
                                    Spacer()
                                    Button("查看全部 →") { store.workspaceTopic = group.0; store.workspaceSearch = ""; store.workspacePage = "Library" }.buttonStyle(FunButtonStyle(small: true))
                                }
                                ForEach(Array(group.1.prefix(2))) { ranked in PaperCard(store: store, ranked: ranked) }
                            }
                        }
                    }
                    if !store.discovery.fetchedAt.isEmpty { Text("最近抓取：\(store.discovery.fetchedAt.prefix(19)) · 最近发表列表，非今天新增数量").font(.system(size: 11)).foregroundColor(.inkSoft) }
                    ForEach(store.discovery.errors, id: \.self) { Text($0 + " · 已保留上次结果，可刷新重试").font(.system(size: 12)).foregroundColor(.accent) }
                    if store.discoveryBusy { HStack { ProgressView(); Text("发现新论文…").font(.system(size: 12)) } }
                    Text("论文与想法默认保存在本机。使用 AI 会发送相关论文材料；迁移分析还会发送研究画像约束。").font(.system(size: 10)).foregroundColor(.inkSoft)
                }.padding(.horizontal, 16).padding(.bottom, 32).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.task { await store.refreshDiscovery() }
    }
}
