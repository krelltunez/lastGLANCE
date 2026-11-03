import SwiftUI

// Renders a Lucide icon from the generated path data in
// LucideIcons.generated.swift. The iOS counterpart of Android's ic_lucide_*
// vector drawables, but vector-crisp at any size from one shared data file
// instead of 1,700 per-density XMLs.
//
// The parser below is a hand-kept mirror of interpretPath() in
// scripts/gen-lucide-swift.mjs — same cursor-based scanning, same implicit-
// command rules, same arc handling. The JS side runs against every icon at
// generation time, so geometry bugs fail the generator on Linux rather than
// rendering garbage here. If you change one side, change the other.
//
// Two scanning details that are load-bearing, learned from the generator's
// validation pass:
//  - Arc flags are single characters that may be juxtaposed with the next
//    number ("a2.5 2.5 0 011.3-2.4" is flags 0,1 then x=1.3). They must be
//    read as one char each, never through the number scanner.
//  - Extra pairs after a moveto are implicit linetos in the moveto's
//    relativity.

enum LucideIcons {
    // Parsed lazily from the generated blob on first access; `static let` gives
    // one-time thread-safe initialization for free.
    static let paths: [String: String] = parseLines(LucideIconData.blob, capacity: 2048)

    // Every other name chore.icon can store, to the name its path data is under.
    static let aliases: [String: String] = parseLines(LucideIconData.aliases, capacity: 2560)

    private static func parseLines(_ blob: String, capacity: Int) -> [String: String] {
        var out = [String: String](minimumCapacity: capacity)
        for line in blob.split(separator: "\n") {
            guard let sep = line.firstIndex(of: " ") else { continue }
            out[String(line[..<sep])] = String(line[line.index(after: sep)...])
        }
        return out
    }

    static func path(named name: String) -> Path? {
        guard let d = paths[name] ?? aliases[name].flatMap({ paths[$0] }) else { return nil }
        return parseSVGPath(d)
    }
}

// The chore icon as it appears in widget rows: stroked in the given colour with
// Lucide's own stroke geometry (width 2, round caps and joins, in a 24x24
// viewBox), scaled to `size`. Clipped to its frame exactly as SVG clips to the
// viewBox — upstream lucide data is allowed to contain segments outside it
// (this version's SaveOff does) and they must stay invisible here, as they are
// in the app and on Android.
struct LucideIconView: View {
    let name: String
    let color: Color
    let size: CGFloat

    var body: some View {
        if let path = LucideIcons.path(named: name) {
            let scale = size / 24
            path
                .applying(CGAffineTransform(scaleX: scale, y: scale))
                .stroke(color, style: StrokeStyle(
                    lineWidth: 2 * scale,
                    lineCap: .round,
                    lineJoin: .round
                ))
                .frame(width: size, height: size)
                .clipped()
        }
    }
}

// MARK: - SVG path parsing

private struct PathScanner {
    let chars: [Character]
    var i = 0

    init(_ s: String) { chars = Array(s) }

    mutating func skipSeparators() {
        while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\t" { i += 1 }
    }

    mutating func atEnd() -> Bool {
        skipSeparators()
        return i >= chars.count
    }

    // The command letter at the cursor, or nil if a number is next.
    mutating func command() -> Character? {
        skipSeparators()
        guard i < chars.count, "MmLlHhVvCcSsQqTtAaZz".contains(chars[i]) else { return nil }
        defer { i += 1 }
        return chars[i]
    }

    mutating func number() -> Double? {
        skipSeparators()
        var s = ""
        if i < chars.count, chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
        var sawDigit = false
        while i < chars.count, chars[i].isNumber { s.append(chars[i]); i += 1; sawDigit = true }
        if i < chars.count, chars[i] == "." {
            s.append("."); i += 1
            while i < chars.count, chars[i].isNumber { s.append(chars[i]); i += 1; sawDigit = true }
        }
        guard sawDigit else { return nil }
        if i < chars.count, chars[i] == "e" || chars[i] == "E" {
            var exp = String(chars[i]); var j = i + 1
            if j < chars.count, chars[j] == "-" || chars[j] == "+" { exp.append(chars[j]); j += 1 }
            var expDigit = false
            while j < chars.count, chars[j].isNumber { exp.append(chars[j]); j += 1; expDigit = true }
            if expDigit { s += exp; i = j }
        }
        return Double(s)
    }

    // An arc flag: exactly one character, 0 or 1. Never the number scanner.
    mutating func flag() -> Bool? {
        skipSeparators()
        guard i < chars.count, chars[i] == "0" || chars[i] == "1" else { return nil }
        defer { i += 1 }
        return chars[i] == "1"
    }
}

// Parses SVG path data into a Path in the 24x24 viewBox space. Returns nil on
// malformed data rather than a partial path: the generator validated every
// bundled string, so a parse failure here means data corruption, and half an
// icon is worse than none.
private func parseSVGPath(_ d: String) -> Path? {
    var sc = PathScanner(d)
    var path = Path()
    var cmd: Character? = nil
    var cx = 0.0, cy = 0.0           // current point
    var sx = 0.0, sy = 0.0           // subpath start
    var pcx: Double? = nil, pcy: Double? = nil  // previous control point
    var prevCmd: Character? = nil

    while !sc.atEnd() {
        if let next = sc.command() {
            cmd = next
        } else if cmd == nil {
            return nil               // number before any command
        } else if cmd == "M" { cmd = "L" }   // implicit repeat: M's extras are L
        else if cmd == "m" { cmd = "l" }
        else if cmd == "Z" || cmd == "z" { return nil }

        guard let c = cmd else { return nil }
        let rel = c.isLowercase

        switch Character(c.uppercased()) {
        case "M":
            guard let a1 = sc.number(), let a2 = sc.number() else { return nil }
            cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
            sx = cx; sy = cy
            path.move(to: CGPoint(x: cx, y: cy))
            pcx = nil; pcy = nil
        case "L":
            guard let a1 = sc.number(), let a2 = sc.number() else { return nil }
            cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
            path.addLine(to: CGPoint(x: cx, y: cy))
            pcx = nil; pcy = nil
        case "H":
            guard let a = sc.number() else { return nil }
            cx = rel ? cx + a : a
            path.addLine(to: CGPoint(x: cx, y: cy))
            pcx = nil; pcy = nil
        case "V":
            guard let a = sc.number() else { return nil }
            cy = rel ? cy + a : a
            path.addLine(to: CGPoint(x: cx, y: cy))
            pcx = nil; pcy = nil
        case "C":
            guard let a1 = sc.number(), let a2 = sc.number(), let a3 = sc.number(),
                  let a4 = sc.number(), let a5 = sc.number(), let a6 = sc.number() else { return nil }
            let c1x = rel ? cx + a1 : a1, c1y = rel ? cy + a2 : a2
            let c2x = rel ? cx + a3 : a3, c2y = rel ? cy + a4 : a4
            cx = rel ? cx + a5 : a5; cy = rel ? cy + a6 : a6
            path.addCurve(to: CGPoint(x: cx, y: cy),
                          control1: CGPoint(x: c1x, y: c1y),
                          control2: CGPoint(x: c2x, y: c2y))
            pcx = c2x; pcy = c2y
        case "S":
            let refl = prevCmd.map { "CcSs".contains($0) } == true && pcx != nil
            let c1x = refl ? 2 * cx - pcx! : cx
            let c1y = refl ? 2 * cy - pcy! : cy
            guard let a1 = sc.number(), let a2 = sc.number(),
                  let a3 = sc.number(), let a4 = sc.number() else { return nil }
            let c2x = rel ? cx + a1 : a1, c2y = rel ? cy + a2 : a2
            cx = rel ? cx + a3 : a3; cy = rel ? cy + a4 : a4
            path.addCurve(to: CGPoint(x: cx, y: cy),
                          control1: CGPoint(x: c1x, y: c1y),
                          control2: CGPoint(x: c2x, y: c2y))
            pcx = c2x; pcy = c2y
        case "Q":
            guard let a1 = sc.number(), let a2 = sc.number(),
                  let a3 = sc.number(), let a4 = sc.number() else { return nil }
            let qx = rel ? cx + a1 : a1, qy = rel ? cy + a2 : a2
            cx = rel ? cx + a3 : a3; cy = rel ? cy + a4 : a4
            path.addQuadCurve(to: CGPoint(x: cx, y: cy), control: CGPoint(x: qx, y: qy))
            pcx = qx; pcy = qy
        case "T":
            let refl = prevCmd.map { "QqTt".contains($0) } == true && pcx != nil
            let qx = refl ? 2 * cx - pcx! : cx
            let qy = refl ? 2 * cy - pcy! : cy
            guard let a1 = sc.number(), let a2 = sc.number() else { return nil }
            cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
            path.addQuadCurve(to: CGPoint(x: cx, y: cy), control: CGPoint(x: qx, y: qy))
            pcx = qx; pcy = qy
        case "A":
            guard let rx = sc.number(), let ry = sc.number(), let rot = sc.number(),
                  let laf = sc.flag(), let sf = sc.flag(),
                  let a6 = sc.number(), let a7 = sc.number() else { return nil }
            let ex = rel ? cx + a6 : a6, ey = rel ? cy + a7 : a7
            addArc(&path, from: (cx, cy), to: (ex, ey),
                   rx: rx, ry: ry, rotationDeg: rot, largeArc: laf, sweep: sf)
            cx = ex; cy = ey
            pcx = nil; pcy = nil
        case "Z":
            path.closeSubpath()
            cx = sx; cy = sy
            pcx = nil; pcy = nil
        default:
            return nil
        }
        prevCmd = cmd
    }
    return path
}

// Elliptical arc → cubic Béziers: endpoint-to-center conversion per SVG spec
// F.6.5 (the same math the generator's validator runs), then one cubic per
// slice of at most 90°, with the standard 4/3·tan(δ/4) control-point constant.
private func addArc(_ path: inout Path,
                    from p1: (Double, Double), to p2: (Double, Double),
                    rx rxIn: Double, ry ryIn: Double,
                    rotationDeg: Double, largeArc: Bool, sweep: Bool) {
    let (x1, y1) = p1, (x2, y2) = p2
    var rx = abs(rxIn), ry = abs(ryIn)
    if rx == 0 || ry == 0 || (x1 == x2 && y1 == y2) {
        path.addLine(to: CGPoint(x: x2, y: y2))
        return
    }
    let phi = rotationDeg * .pi / 180
    let cosP = cos(phi), sinP = sin(phi)
    let dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
    let x1p = cosP * dx + sinP * dy
    let y1p = -sinP * dx + cosP * dy
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 { let s = lambda.squareRoot(); rx *= s; ry *= s }
    let sign: Double = (largeArc != sweep) ? 1 : -1
    let numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    let co = sign * (max(0, numer / denom)).squareRoot()
    let cxp = co * (rx * y1p) / ry
    let cyp = co * (-ry * x1p) / rx
    let cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
    let cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2

    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
        let dot = ux * vx + uy * vy
        let len = (ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot()
        var a = acos(min(1, max(-1, dot / len)))
        if ux * vy - uy * vx < 0 { a = -a }
        return a
    }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    if sweep && dTheta < 0 { dTheta += 2 * .pi }

    func point(_ t: Double) -> CGPoint {
        CGPoint(x: cx + rx * cosP * cos(t) - ry * sinP * sin(t),
                y: cy + rx * sinP * cos(t) + ry * cosP * sin(t))
    }
    func derivative(_ t: Double) -> (Double, Double) {
        (-rx * cosP * sin(t) - ry * sinP * cos(t),
         -rx * sinP * sin(t) + ry * cosP * cos(t))
    }

    let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let delta = dTheta / Double(segments)
    let alpha = 4.0 / 3.0 * tan(delta / 4)
    var t = theta1
    for _ in 0..<segments {
        let tNext = t + delta
        let p0 = point(t), p3 = point(tNext)
        let d0 = derivative(t), d3 = derivative(tNext)
        path.addCurve(
            to: p3,
            control1: CGPoint(x: p0.x + alpha * d0.0, y: p0.y + alpha * d0.1),
            control2: CGPoint(x: p3.x - alpha * d3.0, y: p3.y - alpha * d3.1)
        )
        t = tNext
    }
}
