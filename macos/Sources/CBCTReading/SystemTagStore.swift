import Foundation

// 系统标签的 Store 层接入（PRD 7.2）。
// 派生输入 = 论文可检索文本（标题/摘要/venue）+ 已抽取实验字段的 k/v。
// 只读、无副作用，不写入 LibraryState.tags（那是用户自建标签，两者并存）。

extension Store {
    /// 汇总用于派生系统标签的文本片段。
    func tagFields(for paper: QueueEntry) -> [String] {
        var fields: [String] = []
        if let t = paper.title { fields.append(t) }
        if let a = paper.abstract { fields.append(a) }
        if let v = paper.venue { fields.append(v) }
        if let w = paper.why { fields.append(w) }
        // 已抽取的实验字段：让 views/dataset/metrics 等进入匹配范围
        if let json = loadReadings(paper.key)?.experimentJSON,
           let extraction = try? ExperimentExtraction.decode(json) {
            for (_, _, items) in extraction.groups {
                for item in items { fields.append(item.k); fields.append(item.v) }
            }
        }
        // 原精读笔记的 frontmatter（task/geometry/views/data/volume_repr…）
        if let note = noteForQueue(paper) {
            for (_, value) in note.meta { fields.append(value.str) }
            for (_, body) in note.sections { fields.append(body) }
        }
        return fields.filter { !$0.isEmpty }
    }

    func systemTags(for paper: QueueEntry) -> [SystemTag] {
        SystemTags.derive(from: tagFields(for: paper))
    }

    /// 论文是否命中某个系统标签（用于筛选）。
    func hasSystemTag(_ paper: QueueEntry, category: SystemTagCategory, value: String) -> Bool {
        systemTags(for: paper).contains { $0.category == category && $0.value == value }
    }
}
