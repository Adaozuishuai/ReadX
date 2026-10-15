import AppKit

// 生成「读」字印章图标 → AppIcon.iconset → 由 build-app.sh 转成 icns
let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let bg = NSColor(red: 0.706, green: 0.333, blue: 0.176, alpha: 1)
let rect = NSRect(x: 40, y: 40, width: size - 80, height: size - 80)
let path = NSBezierPath(roundedRect: rect, xRadius: 180, yRadius: 180)
bg.setFill()
path.fill()
// 内描边（印章感）
let inner = NSBezierPath(roundedRect: NSRect(x: 70, y: 70, width: size - 140, height: size - 140), xRadius: 150, yRadius: 150)
NSColor(red: 1, green: 0.97, blue: 0.94, alpha: 0.55).setStroke()
inner.lineWidth = 10
inner.stroke()
let font = NSFont.systemFont(ofSize: 600, weight: .bold).fontDescriptor.withDesign(.serif).flatMap { NSFont(descriptor: $0, size: 600) } ?? NSFont.systemFont(ofSize: 600)
let s = NSAttributedString(string: "读", attributes: [.font: font, .foregroundColor: NSColor(red: 1, green: 0.97, blue: 0.94, alpha: 1)])
let b = s.boundingRect(with: NSSize(width: size, height: size), options: NSString.DrawingOptions.usesLineFragmentOrigin)
s.draw(at: NSPoint(x: (size - b.width) / 2, y: (size - b.height) / 2 - 24))
image.unlockFocus()

let fm = FileManager.default
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func writePNG(_ px: Int, _ name: String) {
    let out = NSImage(size: NSSize(width: px, height: px))
    out.lockFocus()
    image.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/icon_\(name).png"))
}

for (px, name) in [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
                   (128, "128x128"), (256, "128x128@2x"), (256, "256x256"), (512, "256x256@2x"),
                   (512, "512x512"), (1024, "512x512@2x")] {
    writePNG(px, name)
}
print("iconset written to \(outDir)")
