// ocr：用 macOS Vision 辨識圖片裡的文字（繁中＋英文，本機執行），一行一個文字區塊印到 stdout
// 用法：ocr <圖片路徑>
// 給 Obsidian 外掛「錄音筆記（本機）」用：錄音中貼的截圖 → 文字放在逐字稿裡，並當作 whisper 的詞彙提示
// 說明：README.md 與 docs/使用說明.md
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("用法：ocr <圖片路徑>\n".data(using: .utf8)!); exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hant", "en-US"]
req.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(url: url).perform([req])
} catch {
    FileHandle.standardError.write("辨識失敗：\(error)\n".data(using: .utf8)!); exit(1)
}
// 依位置排序：由上而下、由左而右（Vision 座標原點在左下）
let obs = (req.results ?? []).sorted {
    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 ? $0.boundingBox.midY > $1.boundingBox.midY
                                                          : $0.boundingBox.minX < $1.boundingBox.minX
}
for o in obs {
    if let t = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !t.isEmpty { print(t) }
}
