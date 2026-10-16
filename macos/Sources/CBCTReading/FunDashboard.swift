import SwiftUI

struct AdventureCard: View {
    @ObservedObject var store: Store
    var takeaway: String {
        if let today = store.today, let id = today.noteId, let text = store.notes.first(where: { $0.id == id })?.sections["summary"], !text.isEmpty { return text }
        return "选中原文，记录证据，把理解写成自己的研究想法。"
    }
    var body: some View {
        FunPanel(height: FunLayout.dashboardHeight) {
            FunPill(text: "今日阅读", color: .funYellow)
            Text(store.today?.title ?? "今天，从一篇论文开始。").font(.system(size: 20, weight: .heavy)).lineLimit(3).textSelection(.enabled)
            Text(store.today?.venue ?? "导入 PDF 或刷新论文，开启阅读。").font(.system(size: 11)).foregroundColor(.inkSoft).lineLimit(1)
            VStack(spacing: 16) {
                row(1, "快速浏览", "它解决了什么问题？", .funPink, step: 1)
                row(2, "深入精读", "方法是怎么工作的？", .tealSoft, step: 2)
                row(3, "建立关联", "该关联到你已读的哪篇？", .accentSoft, step: 4)
            }.frame(height: 188)
            Spacer(minLength: 0)
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("今日要点").font(.system(size: 11, weight: .heavy)).foregroundColor(.gold)
                    Text(takeaway).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).frame(height: 92).background(RoundedRectangle(cornerRadius: 16).fill(Color(hex: 0xFFF7D6))).overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.ink, lineWidth: 1.5))
        }
    }
    var currentStep: Int { store.today.flatMap { store.progress[$0.key]?.step } ?? 1 }
    func row(_ n: Int, _ title: String, _ subtitle: String, _ color: Color, step: Int) -> some View {
        let isCurrent = currentStep == step
        return HStack(spacing: 12) {
            Text("\(n)").font(.system(size: 13, weight: .heavy)).frame(width: 31, height: 31).background(Circle().fill(color)).overlay(Circle().stroke(Color.ink, lineWidth: 1.5))
            VStack(alignment: .leading, spacing: 5) { Text(title).font(.system(size: 14, weight: .heavy)); Text(subtitle).font(.system(size: 10)).foregroundColor(.inkSoft) }
            Spacer(minLength: 3)
            Button(isCurrent ? "继续" : "打开") {
                guard let ref = store.today else { store.workspacePage = "Library"; return }
                guard store.openReader(ref) else { return }
                store.setStep(step)
            }.buttonStyle(FunButtonStyle(primary: isCurrent)).accessibilityLabel((isCurrent ? "继续 " : "打开 ") + title)
        }.frame(height: 52)
    }
}

struct StreakGardenCard: View {
    @ObservedObject var store: Store
    var week: [Date] {
        var calendar = Calendar.current; calendar.firstWeekday = 2
        let today = calendar.startOfDay(for: Date())
        let mondayOffset = (calendar.component(.weekday, from: today) + 5) % 7
        let monday = calendar.date(byAdding: .day, value: -mondayOffset, to: today) ?? today
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: monday) }
    }
    var completed: Set<String> { Set(store.progress.values.compactMap { $0.doneAt.map { String($0.prefix(10)) } }) }
    func dayKey(_ date: Date) -> String { let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: date) }
    var body: some View {
        FunPanel(color: .funYellow, height: FunLayout.streakHeight) {
            Text("连续阅读").font(.system(size: 15, weight: .heavy))
            Text("\(store.streak) 天").font(.system(size: 34, weight: .heavy))
            Text(store.streak > 0 ? "别让链条断掉。" : "下一次精读将点亮链条。").font(.system(size: 10, weight: .semibold)).foregroundColor(.gold)
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                ForEach(Array(week.enumerated()), id: \.offset) { index, date in
                    let done = completed.contains(dayKey(date))
                    VStack(spacing: 10) {
                        ZStack { Circle().fill(done ? Color.ink : .white).overlay(Circle().stroke(Color.ink, lineWidth: 1.1)); if done { Text("✓").font(.system(size: 11, weight: .heavy)).foregroundColor(.white) } }.frame(width: 19, height: 19)
                        Text(["一", "二", "三", "四", "五", "六", "日"][index]).font(.system(size: 9, weight: .bold))
                    }.frame(maxWidth: .infinity).accessibilityLabel(dayKey(date) + (done ? " · 已完成" : " · 未完成"))
                }
            }
        }
    }
}

struct TopicGardenCard: View {
    @ObservedObject var store: Store
    let colors: [Color] = [.funPink, .accentSoft, .funMint, .funPeach, .funBlue]
    var body: some View {
        FunPanel(color: .tealSoft, height: FunLayout.gardenHeight) {
            Text("主题花园").font(.system(size: 15, weight: .heavy))
            Text("你正在关注的研究主题").font(.system(size: 10)).foregroundColor(.teal)
            let topics = Array(TopicNavigation.topics(store).prefix(6))
            if topics.isEmpty { Text("在研究画像中种下一个主题。").font(.system(size: 12)) }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                ForEach(Array(topics.enumerated()), id: \.element) { index, topic in
                    Button { store.workspaceSearch = ""; store.workspaceTopic = topic; store.workspacePage = "Library" } label: { FunPill(text: topic, color: colors[index % colors.count], fillWidth: true).lineLimit(1).minimumScaleFactor(0.8) }.buttonStyle(.plain).help(topic).accessibilityLabel(topic + " · 主题标签")
                }
            }
            Spacer(minLength: 0)
            HStack {
                Button("全部主题 →") { store.workspacePage = "Topics" }.buttonStyle(.plain).font(.system(size: 10, weight: .bold))
                Spacer()
            }
        }
    }
}
struct PlaygroundCard: View {
    @ObservedObject var store: Store
    var linkedCount: Int { store.ideas.filter { !$0.evidence.isEmpty }.count }
    var body: some View {
        FunPanel(color: .funLavender, height: FunLayout.dashboardHeight) {
            Text("知识图谱").font(.system(size: 15, weight: .heavy))
            Text("来自你保存的论文关联材料").font(.system(size: 10)).foregroundColor(.inkSoft)
            TopicPlayground(store: store).frame(maxHeight: .infinity)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("已关联 \(linkedCount) 条想法").font(.system(size: 12, weight: .heavy))
                    Text("来自你保存的论文关联材料").font(.system(size: 9)).foregroundColor(.inkSoft)
                }
                Spacer(minLength: 0)
                Button("查看地图") { store.workspacePage = "Map" }.buttonStyle(FunButtonStyle(primary: true))
            }.padding(14).frame(height: 72).background(RoundedRectangle(cornerRadius: 16).fill(.white)).overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.ink, lineWidth: 1.5))
        }
    }
}

struct TopicPlayground: View {
    @ObservedObject var store: Store
    var body: some View {
        GeometryReader { geo in
            let topics = Array(TopicNavigation.topics(store).filter { $0.caseInsensitiveCompare("CBCT") != .orderedSame }.prefix(5))
            let points: [(CGFloat, CGFloat)] = [(0.19, 0.40), (0.80, 0.40), (0.50, 0.65), (0.13, 0.89), (0.85, 0.89)]
            let colors: [Color] = [.funPink, .funBlue, .funMint, .accentSoft, .funPeach]
            ZStack {
                Canvas { context, size in
                    for index in topics.indices {
                        let from = CGPoint(x: size.width * 0.5, y: size.height * 0.14)
                        var path = Path(); path.move(to: from); path.addLine(to: CGPoint(x: size.width * points[index].0, y: size.height * points[index].1)); context.stroke(path, with: .color(.ink), lineWidth: 1.3)
                    }
                }
                Text("CBCT").font(.system(size: 12, weight: .heavy)).foregroundColor(.white).frame(width: 50, height: 50).background(Circle().fill(Color.accent)).overlay(Circle().stroke(Color.ink, lineWidth: 1.5)).position(x: geo.size.width * 0.5, y: geo.size.height * 0.14)
                ForEach(Array(topics.enumerated()), id: \.element) { index, topic in
                    Button { store.workspaceTopic = topic; store.workspaceSearch = ""; store.workspacePage = "Library" } label: {
                        Text(topic).font(.system(size: 9, weight: .heavy)).lineLimit(2).multilineTextAlignment(.center).frame(width: 53, height: 53).background(Circle().fill(colors[index])).overlay(Circle().stroke(Color.ink, lineWidth: 1.3))
                    }.buttonStyle(.plain).accessibilityLabel(topic + " · 筛选论文").position(x: geo.size.width * points[index].0, y: geo.size.height * points[index].1)
                }
            }
        }
    }
}

struct TopicMapWorkspace: View {
    @ObservedObject var store: Store
    /// 趋势与缺口（PRD 4.16）。所有结论同时展示时间窗、样本数与证据集合；
    /// 样本不足时明确标注「不下趋势判断」。
    @ViewBuilder
    private var trendSection: some View {
        let papers = store.savedPapers
        let sample = TrendAnalysis.sample(papers)
        let findings = TrendAnalysis.findings(papers) { store.systemTags(for: $0) }
        Text("趋势与缺口").font(.system(size: 21, weight: .heavy))
        FunPanel {
            Text("检索范围：\(sample.count) 篇论文 · 时间窗口：\(sample.isWindowBounded ? "\(sample.windowStart!) – \(sample.windowEnd!)" : "年份未提供")")
                .font(.system(size: 12, weight: .bold))
            Text("样本不足 \(TrendAnalysis.minimumSample) 篇时只报告计数，不判断「升温 / 新兴 / 首次」。")
                .font(.system(size: 11)).foregroundColor(.inkSoft)
            if findings.isEmpty {
                Text("尚未从论文文本中派生出系统标签，无法统计趋势。").font(.system(size: 12)).foregroundColor(.inkSoft)
            } else {
                ForEach(Array(findings.prefix(8).enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(f.claim).font(.system(size: 13, weight: .semibold))
                        Text(f.disclosure).font(.system(size: 11)).foregroundColor(.teal)
                        Text(f.caveat).font(.system(size: 11)).foregroundColor(.inkSoft)
                    }.padding(.vertical, 4)
                }
            }
            if let gap = findings.first(where: { !$0.isSupported }) {
                Text(TrendAnalysis.gapStatement(topic: gap.topic, sample: sample))
                    .font(.system(size: 11)).foregroundColor(.gold)
            }
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(store.workspacePage == "Topics" ? "你的主题花园" : "你的知识地图").font(.system(size: 28, weight: .heavy))
                Text("主题按论文标题与摘要匹配；Idea 的论文关联来自你保存的材料。连线表示分类与材料关联。").font(.system(size: 12)).foregroundColor(.inkSoft)
                HStack(alignment: .top, spacing: 18) {
                    FunPanel(color: .funLavender) { TopicPlayground(store: store).frame(height: 260) }.frame(width: 340)
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(TopicNavigation.topics(store), id: \.self) { topic in
                            let count = store.savedPapers.filter { TopicNavigation.matches($0, topic: topic) }.count
                            Button { store.workspaceTopic = topic; store.workspaceSearch = ""; store.workspacePage = "Library" } label: { HStack { FunPill(text: topic, color: .tealSoft); Spacer(); Text("\(count) 篇论文 →").font(.system(size: 12, weight: .bold)) }.padding(8) }.buttonStyle(.plain)
                        }
                        Button("编辑关注主题") { store.workspacePage = "Profile" }.buttonStyle(FunButtonStyle())
                    }.frame(maxWidth: .infinity)
                }
                // PRD 4.16 / 第 12 节风险表：趋势必须披露「时间窗口 + 样本数 + 证据集合」，
                // 样本不足时不输出趋势判断（避免「样本少导致伪趋势」）。
                trendSection
                Text("想法 ↔ 论文").font(.system(size: 21, weight: .heavy))
                let linked = store.ideas.filter { !$0.evidence.isEmpty }
                if linked.isEmpty { FunPanel { Text("还没有论文关联。精读室第②步选中 PDF 原文，点「保存为 Idea 证据」。").font(.system(size: 13)) } }
                ForEach(linked) { idea in
                    FunPanel {
                        Text(idea.question.isEmpty ? "未命名研究想法" : idea.question).font(.system(size: 17, weight: .bold))
                        ForEach(idea.evidence) { evidence in
                            HStack { Text("↳ " + evidence.paperTitle).font(.system(size: 12)); Spacer(); Text(evidence.origin.rawValue).font(.system(size: 11)).foregroundColor(.teal) }
                            if let page = evidence.page { Text("Page \(page) · " + evidence.excerpt).font(.system(size: 11)).foregroundColor(.inkSoft).lineLimit(2) }
                        }
                        Button("打开想法笔记") { store.workspacePage = "Ideas" }.buttonStyle(FunButtonStyle())
                    }
                }
            }.padding(26)
        }
    }
}
