import SwiftUI
import AppKit

// Shared with Figma's 12-column desktop frame and app/public/fun.css.
enum FunLayout {
    static let gap: CGFloat = 24
    static let dashboardHeight: CGFloat = 520
    static let streakHeight: CGFloat = 224
    static let gardenHeight: CGFloat = 272
    static let heroHeight: CGFloat = 184
    static let controlHeight: CGFloat = 40
    struct Columns {
        let width: CGFloat
        private var unit: CGFloat { (width - 11 * FunLayout.gap) / 12 }
        var adventure: CGFloat { unit * 5 + 4 * FunLayout.gap }
        var middle: CGFloat { unit * 3 + 2 * FunLayout.gap }
        var knowledge: CGFloat { unit * 4 + 3 * FunLayout.gap }
    }
}

struct FunBackground: View {
    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.paper
                Circle().fill(Color(hex: 0xE8FBFF)).frame(width: 360, height: 360).position(x: geo.size.width - 20, y: 20)
                Circle().fill(Color(hex: 0xFFF0DB)).frame(width: 330, height: 330).position(x: 25, y: geo.size.height)
                Circle().fill(Color.accentSoft.opacity(0.7)).frame(width: 360, height: 360).position(x: geo.size.width - 70, y: geo.size.height)
            }.clipped()
        }.accessibilityHidden(true)
    }
}

struct FunPanel<Content: View>: View {
    var color: Color = .white
    var padding: CGFloat = 24
    var height: CGFloat? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: height, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 24).fill(color))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color.ink, lineWidth: 1.5))
            .shadow(color: .ink.opacity(0.045), radius: 10, x: 0, y: 5)
    }
}
struct FunPill: View {
    var text: String
    var color: Color
    var fillWidth = false
    var body: some View {
        Text(text).font(.system(size: 11, weight: .bold)).padding(.horizontal, 12).frame(height: 32)
            .frame(maxWidth: fillWidth ? .infinity : nil)
            .background(Capsule().fill(color)).overlay(Capsule().stroke(Color.ink, lineWidth: 1))
    }
}
struct FunButtonStyle: ButtonStyle {
    var primary = false
    var teal = false
    var small = false
    var color: Color = .white
    func makeBody(configuration: Configuration) -> some View {
        let fill = primary ? Color.ink : (teal ? Color.tealSoft : color)
        let foreground = primary ? Color.paper : (teal ? Color.teal : Color.ink)
        return configuration.label
            .font(.system(size: small ? 11 : 12, weight: .bold))
            .padding(.horizontal, small ? 12 : 16)
            .frame(height: small ? 30 : FunLayout.controlHeight)
            .foregroundColor(foreground)
            .background(Capsule().fill(fill))
            .overlay(Capsule().stroke(Color.ink, lineWidth: 1.5))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}
struct FunFace: View {
    var color: Color = .accent
    var smile = false
    var body: some View {
        GeometryReader { geo in
            let size = geo.size.width
            ZStack {
                Circle().fill(color).overlay(Circle().stroke(Color.ink, lineWidth: 1.6))
                HStack(spacing: size * 0.24) {
                    Circle().fill(smile ? Color.ink : .white).frame(width: size * 0.12, height: size * 0.12)
                    Circle().fill(smile ? Color.ink : .white).frame(width: size * 0.12, height: size * 0.12)
                }.offset(y: -size * 0.12)
                if smile {
                    Path { p in p.move(to: CGPoint(x: size * 0.3, y: size * 0.63)); p.addQuadCurve(to: CGPoint(x: size * 0.7, y: size * 0.63), control: CGPoint(x: size * 0.5, y: size * 0.9)) }.stroke(Color.ink, style: StrokeStyle(lineWidth: max(1.5, size * 0.05), lineCap: .round))
                } else { Capsule().fill(Color.white).frame(width: size * 0.3, height: size * 0.06).offset(y: size * 0.18) }
            }
        }.aspectRatio(1, contentMode: .fit).accessibilityHidden(true)
    }
}
