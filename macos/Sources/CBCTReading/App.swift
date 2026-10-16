import SwiftUI
import AppKit

@main
struct CBCTReadingApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .frame(minWidth: 1000, minHeight: 660)
                .navigationTitle("CBCT 每日精读")
                .onAppear {
                    // 本应用为单窗口工作台：全局关闭窗口自动合入标签页，
                    // 避免精读会话被并入其他窗口（如 ZCode）的标签页集合。
                    NSWindow.allowsAutomaticWindowTabbing = false
                }
                // ⌘Q / 关窗口时第④步草稿还只在内存里，必须在此落盘，否则用户刚写的
                // 反思与自由批注会随退出消失（另外两条落盘路径是「书桌」与「完成精读」）。
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    _ = store.flushActiveSession()
                    _ = store.flushPendingPersists()
                }
        }
    }
}
