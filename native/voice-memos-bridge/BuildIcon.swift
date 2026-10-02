// Package the existing Mycelia vector logo as a native, multi-resolution icon.
import AppKit
import Foundation

@main
enum BuildIcon {
  static func main() throws {
    guard CommandLine.arguments.count == 3,
      let logo = NSImage(contentsOfFile: CommandLine.arguments[1])
    else {
      throw NSError(
        domain: "BridgeIcon", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Expected existing Mycelia SVG and output iconset"])
    }
    let destination = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    for points in [16, 32, 128, 256, 512] {
      for scale in [1, 2] {
        let pixels = points * scale
        guard
          let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap)
        else {
          throw NSError(domain: "BridgeIcon", code: 2)
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        let size = CGFloat(pixels)
        NSColor(calibratedRed: 0.055, green: 0.13, blue: 0.19, alpha: 1).setFill()
        NSBezierPath(
          roundedRect: NSRect(
            x: size * 0.06, y: size * 0.06,
            width: size * 0.88, height: size * 0.88), xRadius: size * 0.20, yRadius: size * 0.20
        ).fill()
        logo.draw(
          in: NSRect(
            x: size * 0.23, y: size * 0.28,
            width: size * 0.54, height: size * 0.59), from: .zero, operation: .sourceOver,
          fraction: 1)
        NSColor(calibratedRed: 0.30, green: 0.89, blue: 0.76, alpha: 1).setFill()
        for (index, height) in [0.04, 0.075, 0.115, 0.075, 0.04].enumerated() {
          let barHeight = size * height
          NSBezierPath(
            roundedRect: NSRect(
              x: size * (0.36 + Double(index) * 0.065),
              y: size * 0.20 - barHeight / 2, width: size * 0.028, height: barHeight),
            xRadius: size * 0.014, yRadius: size * 0.014
          ).fill()
        }
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
          throw NSError(domain: "BridgeIcon", code: 3)
        }
        let name = "icon_\(points)x\(points)" + (scale == 2 ? "@2x" : "") + ".png"
        try data.write(to: destination.appendingPathComponent(name), options: .atomic)
      }
    }
  }
}
