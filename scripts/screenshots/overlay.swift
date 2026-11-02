import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// overlay <base.png> <region.png> <out.png>
// For shots with a panel over the window (command bar, All Spaces, Peek), which a capture of
// the window alone leaves out. base: the window alone, with its shadow on transparency.
// region: the screen area of the window's frame, panels included. Wherever base is fully
// opaque (the window's body) the region's pixels are used, so the result keeps the window's
// rounded corners and shadow like the other shots.

func load(_ path: String) -> CGImage {
    CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)!, 0, nil)!
}

func bitmap(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

let args = CommandLine.arguments
let base = load(args[1]), region = load(args[2])
let W = base.width, H = base.height
let out = bitmap(W, H)
out.draw(base, in: CGRect(x: 0, y: 0, width: W, height: H))
let b = out.data!.assumingMemoryBound(to: UInt8.self)

// The window's body: the bounding box of fully opaque pixels.
var minX = W, minY = H, maxX = -1, maxY = -1
for y in 0..<H {
    for x in 0..<W where b[(y * W + x) * 4 + 3] == 255 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
}
guard maxX >= 0 else { print("no opaque window body in \(args[1])"); exit(1) }
let bw = maxX - minX + 1, bh = maxY - minY + 1

// The region scaled onto that box, then copied in where the window is opaque.
let r = bitmap(bw, bh)
r.interpolationQuality = .high
r.draw(region, in: CGRect(x: 0, y: 0, width: bw, height: bh))
let rp = r.data!.assumingMemoryBound(to: UInt8.self)
for y in 0..<bh {
    for x in 0..<bw {
        let bi = ((y + minY) * W + (x + minX)) * 4
        guard b[bi + 3] == 255 else { continue }
        let ri = (y * bw + x) * 4
        for c in 0..<4 { b[bi + c] = rp[ri + c] }
    }
}

let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, out.makeImage()!, nil)
CGImageDestinationFinalize(dest)
