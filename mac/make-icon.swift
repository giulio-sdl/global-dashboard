// Draws the app's icon, 1024 pixels square, into the PNG file named on the
// command line: the dashboard's carbon black, a racing-red stripe, and a
// rising line ending in a yellow light. scripts/build-mac-app.sh turns it into
// the icon set macOS wants.

import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// The tile: macOS icons sit inside a margin, with rounded corners.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(calibratedWhite: 0.16, alpha: 1), ending: NSColor(calibratedWhite: 0.05, alpha: 1))!
  .draw(in: shape, angle: -90)
shape.addClip()

// Racing stripe across the top.
NSColor(srgbRed: 0.886, green: 0.137, blue: 0.102, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 100, y: 770, width: 824, height: 70)).fill()

// Faint grid lines, as on a timing screen.
NSColor(calibratedWhite: 1, alpha: 0.07).setStroke()
for y in stride(from: 250.0, through: 690.0, by: 110.0) {
  let line = NSBezierPath()
  line.move(to: NSPoint(x: 170, y: y))
  line.line(to: NSPoint(x: 854, y: y))
  line.lineWidth = 6
  line.stroke()
}

// The market line, rising.
let points = [(180, 300), (300, 360), (390, 330), (500, 470), (600, 430), (700, 570), (820, 650)].map { NSPoint(x: Double($0.0), y: Double($0.1)) }
let chart = NSBezierPath()
chart.move(to: points[0])
points.dropFirst().forEach { chart.line(to: $0) }
chart.lineWidth = 46
chart.lineCapStyle = .round
chart.lineJoinStyle = .round
NSColor(srgbRed: 0.239, green: 0.863, blue: 0.518, alpha: 1).setStroke()
chart.stroke()

// A yellow light where it ends.
NSColor(srgbRed: 1, green: 0.839, blue: 0.039, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 820 - 52, y: 650 - 52, width: 104, height: 104)).fill()

image.unlockFocus()

let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
