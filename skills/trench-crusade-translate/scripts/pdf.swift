import AppKit
import CoreGraphics
import CoreText
import Foundation
import PDFKit

// macOS: swift pdf.swift inspect source.pdf
//        swift pdf.swift preview source.pdf 2 /tmp/page-2.png
//        swift pdf.swift render source.pdf translation.txt output.pdf [--logo logo.png]
//              [--ornament ornament.png] [--illustration art.png ...] [--force]

func fail(_ message: String) -> Never {
    fputs("Error: \(message)\n", stderr)
    exit(1)
}

func document(_ path: String) -> PDFDocument {
    guard let pdf = PDFDocument(url: URL(fileURLWithPath: path)), pdf.pageCount > 0 else {
        fail("Cannot read PDF: \(path)")
    }
    return pdf
}

func image(_ path: String) -> CGImage {
    guard let nsImage = NSImage(contentsOfFile: path),
          let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("Cannot read image: \(path)")
    }
    return cgImage
}

let args = Array(CommandLine.arguments.dropFirst())
guard let mode = args.first else {
    fail("Usage: swift pdf.swift inspect|preview|render ...")
}

if mode == "inspect" {
    guard args.count == 2 else { fail("Usage: swift pdf.swift inspect source.pdf") }
    let pdf = document(args[1])
    print("\(pdf.pageCount) pages")
    for i in 0..<pdf.pageCount {
        let page = pdf.page(at: i)!
        let characters = page.string?.count ?? 0
        print("page \(i + 1): \(characters) selectable characters")
    }
    exit(0)
}

if mode == "preview" {
    guard args.count == 4, let pageNumber = Int(args[2]) else {
        fail("Usage: swift pdf.swift preview source.pdf page-number output.png")
    }
    let pdf = document(args[1])
    guard (1...pdf.pageCount).contains(pageNumber) else { fail("Page out of range") }
    let thumbnail = pdf.page(at: pageNumber - 1)!.thumbnail(
        of: NSSize(width: 640, height: 960), for: .mediaBox
    )
    guard let tiff = thumbnail.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        fail("Cannot render page \(pageNumber)")
    }
    do {
        try png.write(to: URL(fileURLWithPath: args[3]))
    } catch {
        fail("Cannot save preview: \(error)")
    }
    print(args[3])
    exit(0)
}

guard mode == "render", args.count >= 4 else {
    fail("Usage: swift pdf.swift render source.pdf translation.txt output.pdf [--logo file.png] [--ornament file.png] [--illustration file.png ...] [--force]")
}
let source = URL(fileURLWithPath: args[1])
let draft = URL(fileURLWithPath: args[2])
let destination = URL(fileURLWithPath: args[3])
guard source.standardizedFileURL != destination.standardizedFileURL else {
    fail("Output must not overwrite the source PDF")
}
var logo: String?
var ornament: String?
var illustrations: [String] = []
var force = false
var cursor = 4
while cursor < args.count {
    switch args[cursor] {
    case "--logo", "--ornament", "--illustration":
        guard cursor + 1 < args.count else { fail("Missing value after \(args[cursor])") }
        let option = args[cursor]
        let path = args[cursor + 1]
        guard FileManager.default.fileExists(atPath: path) else { fail("Missing image: \(path)") }
        if option == "--logo" { logo = path }
        else if option == "--ornament" { ornament = path }
        else { illustrations.append(path) }
        cursor += 2
    case "--force":
        force = true
        cursor += 1
    default:
        fail("Unknown option: \(args[cursor])")
    }
}
if FileManager.default.fileExists(atPath: destination.path) && !force {
    fail("Output already exists; use --force only after checking the destination: \(destination.path)")
}
let original = document(args[1])
let raw: String
do {
    raw = try String(contentsOf: draft, encoding: .utf8)
} catch {
    fail("Cannot read UTF-8 translation: \(error)")
}
// Four nonempty lines, then blank-line-separated reader note, copyright, story.
let blocks = raw.replacingOccurrences(of: "\r\n", with: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .components(separatedBy: "\n\n")
guard blocks.count >= 5 else {
    fail("Translation needs four metadata lines, a reader note, copyright, publisher contact block, and story paragraphs")
}
let credits = blocks[0].components(separatedBy: "\n")
guard credits.count == 4, credits.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
    fail("First block must have exactly four nonempty lines: title, author, series, illustration credit")
}
let title = credits[0]
let author = credits[1]
let series = credits[2]
let artCredit = credits[3]
let readerNote = blocks[1]
let copyright = blocks[2]
let imprint = blocks[3]
let story = blocks.dropFirst(4).joined(separator: "\n") // one break + ~half-line spacing
let pageSize = CGRect(x: 0, y: 0, width: 430, height: 646)
let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
defer { try? FileManager.default.removeItem(at: temp) }
var mediaBox = pageSize
guard let ctx = CGContext(temp as CFURL, mediaBox: &mediaBox, nil) else { fail("Cannot create PDF") }
let regular = NSFont(name: "PT Serif", size: 11.25) ?? NSFont(name: "Georgia", size: 11.25) ?? NSFont.systemFont(ofSize: 11.25)
let small = regular.withSize(9)
let heading = NSFont(name: "PT Serif Bold", size: 19) ?? NSFont.boldSystemFont(ofSize: 19)
let para = NSMutableParagraphStyle()
para.lineSpacing = 1.1
para.paragraphSpacing = 7 // roughly half a line, not a whole empty line
para.alignment = .left

func drawText(_ value: String, in rect: CGRect, font: NSFont,
              alignment: NSTextAlignment = .left, color: NSColor = .black) {
    let style = NSMutableParagraphStyle()
    style.alignment = alignment
    style.lineSpacing = 2.2
    let value = NSAttributedString(string: value, attributes: [
        .font: font, .foregroundColor: color, .paragraphStyle: style
    ])
    let setter = CTFramesetterCreateWithAttributedString(value)
    let frame = CTFramesetterCreateFrame(setter, CFRangeMake(0, 0), CGPath(rect: rect, transform: nil), nil)
    guard CTFrameGetVisibleStringRange(frame).length >= value.length else {
        fail("Text does not fit on the credits page; shorten or adjust its layout")
    }
    CTFrameDraw(frame, ctx)
}

ctx.beginPDFPage(nil)
drawText(title.uppercased(), in: CGRect(x: 30, y: 464, width: 370, height: 48), font: heading, alignment: .center)
drawText("\(author)\n\(series)\n\(artCredit)", in: CGRect(x: 35, y: 360, width: 360, height: 100), font: regular, alignment: .center)
drawText(readerNote, in: CGRect(x: 45, y: 302, width: 340, height: 50), font: small, alignment: .center)
drawText(copyright, in: CGRect(x: 55, y: 174, width: 320, height: 115), font: small)
if let ornament {
    ctx.draw(image(ornament), in: CGRect(x: 199, y: 134, width: 32, height: 34))
}
if let logo {
    ctx.draw(image(logo), in: CGRect(x: 63, y: 65, width: 55, height: 56))
}
drawText(imprint, in: CGRect(x: logo == nil ? 65 : 128, y: 64,
                           width: logo == nil ? 300 : 230, height: 63), font: small)
ctx.endPDFPage()

let text = NSAttributedString(string: story, attributes: [
    .font: regular, .foregroundColor: NSColor.black, .paragraphStyle: para
])
let setter = CTFramesetterCreateWithAttributedString(text)
let textBox = CGRect(x: 45, y: 48, width: 340, height: 548)
var location = 0
var storyPages = 0
while location < text.length {
    ctx.beginPDFPage(nil)
    let header = storyPages.isMultiple(of: 2) ? title.uppercased() : author.components(separatedBy: " (")[0].uppercased()
    drawText(header, in: CGRect(x: 45, y: 610, width: 340, height: 16), font: small,
             alignment: .center, color: .darkGray)
    let frame = CTFramesetterCreateFrame(setter, CFRangeMake(location, 0), CGPath(rect: textBox, transform: nil), nil)
    let visible = CTFrameGetVisibleStringRange(frame)
    guard visible.length > 0 else { fail("A page cannot fit any story text") }
    CTFrameDraw(frame, ctx)
    if location + visible.length >= text.length, let ornament {
        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = Array(repeating: CGPoint.zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRangeMake(0, 0), &origins)
        if (origins.last?.y ?? 0) > 49 {
            ctx.draw(image(ornament), in: CGRect(x: 197, y: 48, width: 36, height: 37))
        }
    }
    drawText("\(storyPages + 1)", in: CGRect(x: 45, y: 23, width: 340, height: 15),
             font: small, alignment: .center, color: .darkGray)
    location += visible.length
    storyPages += 1
    ctx.endPDFPage()
}
for path in illustrations {
    let picture = image(path)
    let width = CGFloat(picture.width)
    let height = CGFloat(picture.height)
    let scale = min(340 / width, 540 / height)
    let frame = CGRect(x: (430 - width * scale) / 2, y: (646 - height * scale) / 2,
                       width: width * scale, height: height * scale)
    ctx.beginPDFPage(nil)
    ctx.draw(picture, in: frame)
    ctx.endPDFPage()
}
ctx.closePDF()
let generated = document(temp.path)
let output = PDFDocument()
output.insert(original.page(at: 0)!, at: 0) // preserve original cover and its embedded artwork
for i in 0..<generated.pageCount {
    output.insert(generated.page(at: i)!, at: output.pageCount)
}
output.documentAttributes = [
    PDFDocumentAttribute.titleAttribute: "\(title) — український переклад",
    PDFDocumentAttribute.authorAttribute: author
]
if !output.write(to: destination) { fail("Cannot save PDF: \(destination.path)") }
let saved = document(destination.path)
let recovered = (2..<(storyPages + 2)).map { index -> String in
    let lines = (saved.page(at: index)?.string ?? "").components(separatedBy: "\n")
    guard lines.count >= 3 else { fail("Cannot extract story text from page \(index + 1)") }
    return lines.dropFirst().dropLast().joined()
}.joined().filter { !$0.isWhitespace }
guard recovered == story.filter({ !$0.isWhitespace }) else {
    fail("Saved PDF story does not match the draft (ignoring whitespace); inspect output: \(destination.path)")
}
print("Saved \(destination.path) (\(saved.pageCount) pages, \(storyPages) story pages; story text verified)")
