// Rasterize the project's SVG without adding a background. The output path
// must be new; rebuilding never overwrites an existing user-owned file.
import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: swift render-personal-icon.swift source.svg output.png\n", stderr)
    exit(2)
}
let source = CommandLine.arguments[1]
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOfFile: source),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
      ),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fputs("Unable to render the SVG\n", stderr)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
image.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Unable to encode PNG\n", stderr)
    exit(1)
}
do {
    try png.write(to: output, options: .withoutOverwriting)
} catch {
    fputs("Unable to create the PNG at the requested new path\n", stderr)
    exit(1)
}
