// course-recorder：錄「系統聲音＋麥克風」成一個 m4a（AAC 立體聲）
// 原理：macOS 14.4+ 的 Core Audio process tap 抓系統播出的聲音（不管各 App 選哪個喇叭），
//       跟預設麥克風一起放進一個私有聚集裝置，同一個時脈讀出來、混音、寫檔。
// 用法：course-recorder <輸出檔.m4a> [--transcribe <暫存資料夾>]   收到 SIGINT／SIGTERM 就收尾存檔
//         --video <輸出檔.mp4>：同時錄螢幕。啟動後跳出 macOS 的選擇視窗，選要錄的 App 或視窗（只錄它，其他畫面不會入鏡）；
//                       每秒 5 格、長邊縮到 1920×1080 以內、HEVC。錄影比錄音晚開始，時間差用 VIDEO_OFFSET 告訴外掛
//         --transcribe：同時即時辨識（Apple SpeechTranscriber，zh-TW），對方＝電腦聲音、我＝麥克風，
//                       每句定稿就印一行「SEG<TAB>誰<TAB>開始秒<TAB>結束秒<TAB>文字」；
//                       另外把兩路聲音各存一個 16 kHz WAV（course.wav、mic.wav）給錄完後的 whisper 精修
//       course-recorder --list-processes    列出目前有音訊的程式（看 bundle ID 用）
// stdout 協定（給外掛讀，一行一個事件）：STARTED [LIVE]｜AUDIO｜SEG<TAB>誰<TAB>起<TAB>訖<TAB>文字｜SAVED <路徑>｜EMPTY
//   VIDEO_PICKING｜VIDEO_STARTED <路徑>｜VIDEO_OFFSET <秒，錄影第 0 秒＝錄音第幾秒>｜VIDEO_SAVED <路徑>
//   VIDEO_CANCELLED｜VIDEO_FAILED <原因>｜VIDEO_STOPPED <原因>
//   EXCLUDED_PLAYING <bundle>｜LIVE_FAILED <原因>｜LIVE_STOPPED <誰>｜STALLED｜RESUMED <累計中斷秒數>｜WARN <訊息>
// 設定：~/.config/course-recorder/config.json（沒有就用預設值）
//   excludeBundlePrefixes  不錄這些程式的聲音（預設 []：所有 App 的聲音都錄）
//   micGain                麥克風音量倍率（預設 1.0；0 = 不錄麥克風）
//   bitRate                AAC 位元率（預設 96000）
// 說明：README.md 與 docs/使用說明.md
import AppKit
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit
import Speech
import Synchronization

// 外掛（Obsidian）當掉或關閉時，stdout／stderr 的管線會斷；預設寫入斷掉的管線會被 SIGPIPE 直接殺掉，
// 錄音檔來不及收尾就會壞掉。忽略它，寫不出去就算了。
signal(SIGPIPE, SIG_IGN)
let parentPID = getppid()   // 啟動時就記下來，看門狗用它判斷啟動我們的程式還在不在

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write("錯誤：\(msg)\n".data(using: .utf8)!)
    exit(1)
}
func log(_ msg: String) { FileHandle.standardError.write("\(msg)\n".data(using: .utf8)!) }
// stdout 是給外掛讀的協定，多個執行緒都會寫，要上鎖
let outLock = NSLock()
func emit(_ line: String) { outLock.lock(); print(line); fflush(stdout); outLock.unlock() }

// ---------- 設定 ----------
struct Config: Decodable {
    var excludeBundlePrefixes: [String]?
    var micGain: Float?
    var bitRate: UInt32?
}
let configURL = URL(fileURLWithPath: NSHomeDirectory() + "/.config/course-recorder/config.json")
var configError: String? = nil
let config: Config = {
    guard FileManager.default.fileExists(atPath: configURL.path) else { return Config() }
    do { return try JSONDecoder().decode(Config.self, from: Data(contentsOf: configURL)) }
    catch {
        // 設定檔寫壞時不能悄悄用預設值：使用者以為排除了某個 App，實際上卻錄進去了
        configError = "\(error.localizedDescription)"
        return Config()
    }
}()
let excludePrefixes = config.excludeBundlePrefixes ?? []
let micGain = config.micGain ?? 1.0
let bitRate = config.bitRate ?? 96000

// ---------- Core Audio 小工具 ----------
let systemObject = AudioObjectID(kAudioObjectSystemObject)
func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
    -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func getValue<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T,
                 _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> T? {
    var a = addr(sel, scope)
    var v = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
}
func getString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var cf: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &cf) == noErr, let v = cf else { return nil }
    return v.takeRetainedValue() as String
}
func getArray(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
    var a = addr(sel)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

// 目前有在 Core Audio 註冊的程式（有播放或錄音過的）
func audioProcesses() -> [(id: AudioObjectID, pid: pid_t, bundle: String)] {
    getArray(systemObject, kAudioHardwarePropertyProcessObjectList).map { pid in
        (pid, getValue(pid, kAudioProcessPropertyPID, pid_t(0)) ?? 0,
         getString(pid, kAudioProcessPropertyBundleID) ?? "")
    }
}

// 防爆音：|x| ≤ 0.8（約 -1.9 dBFS）完全不動；超過的部分用 tanh 平滑壓進 0.8～1.0，永遠不會超過 1.0。
// 電腦聲音和麥克風是直接相加，大聲的音樂加上講話就可能超過 1.0 而破音。講課的正常音量碰不到門檻。
@inline(__always) func softLimit(_ x: Float) -> Float {
    let t: Float = 0.8
    let a = abs(x)
    if a <= t { return x }
    let y = t + (1 - t) * tanhf((a - t) / (1 - t))
    return x < 0 ? -y : y
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--selftest-limiter" {
    for x: Float in [0.1, 0.5, 0.79, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 4.0, -1.5] {
        print(String(format: "%5.2f → %.4f", x, softLimit(x)))
    }
    exit(0)
}
if args.count >= 2 && args[1] == "--list-processes" {
    for p in audioProcesses() { print("\(p.pid)\t\(p.bundle)") }
    exit(0)
}
guard args.count >= 2 else { fail("用法：course-recorder <輸出檔.m4a> [--transcribe <暫存資料夾>] | --list-processes") }
let outURL = URL(fileURLWithPath: args[1])
let videoURL: URL? = {
    guard let i = args.firstIndex(of: "--video"), i + 1 < args.count else { return nil }
    return URL(fileURLWithPath: args[i + 1])
}()
let transcribeDir: URL? = {
    guard let i = args.firstIndex(of: "--transcribe"), i + 1 < args.count else { return nil }
    return URL(fileURLWithPath: args[i + 1])
}()

if let e = configError {
    log("設定檔讀不懂，改用預設值：\(e)")
    emit("WARN 設定檔 config.json 格式有誤，這次用預設值（所有 App 都錄、麥克風開）")
}

// ---------- 1. Process tap：系統聲音（排除指定程式） ----------
let excluded = audioProcesses().filter { p in excludePrefixes.contains { p.bundle.hasPrefix($0) } }
if !excluded.isEmpty { log("排除：\(excluded.map { $0.bundle }.joined(separator: ", "))") }
let excludedPlaying = excluded.filter { (getValue($0.id, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0 }
if let p = excludedPlaying.first {
    emit("EXCLUDED_PLAYING \(p.bundle)")  // 給外掛：被排除的程式正在發聲，提醒使用者這段不會錄
}
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded.map { $0.id })
tapDesc.name = "course-recorder tap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
var err = AudioHardwareCreateProcessTap(tapDesc, &tapID)
guard err == noErr else { fail("建立系統聲音 tap 失敗（OSStatus \(err)）") }

// ---------- 2. 私有聚集裝置：輸出裝置（當時脈）＋麥克風＋tap ----------
guard let outDev = getValue(systemObject, kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(0)),
      let outUID = getString(outDev, kAudioDevicePropertyDeviceUID) else { fail("找不到預設輸出裝置") }
guard let micDev = getValue(systemObject, kAudioHardwarePropertyDefaultInputDevice, AudioObjectID(0)),
      let micUID = getString(micDev, kAudioDevicePropertyDeviceUID) else { fail("找不到預設麥克風") }
let micName = getString(micDev, kAudioObjectPropertyName) ?? micUID
let outName = getString(outDev, kAudioObjectPropertyName) ?? outUID
log("麥克風：\(micName)／輸出：\(outName)")

// 有麥克風時用麥克風當時脈（main subdevice）：2026-11-13 實測，用輸出裝置當時脈、而且只有被排除的程式
// 在發聲時，tap 不送資料，整個聚集裝置不跑，連麥克風也錄不到。沒有麥克風時才用輸出裝置。
let useMic = micGain > 0 && micUID != outUID
let mainUID = useMic ? micUID : outUID
let subs: [[String: Any]] = [[kAudioSubDeviceUIDKey: mainUID]]
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "course-recorder",
    kAudioAggregateDeviceUIDKey: "course-recorder-" + UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: mainUID,
    kAudioAggregateDeviceIsPrivateKey: 1,
    kAudioAggregateDeviceIsStackedKey: 0,
    kAudioAggregateDeviceTapAutoStartKey: 1,
    kAudioAggregateDeviceSubDeviceListKey: subs,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
                                       kAudioSubTapDriftCompensationKey: 1]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
err = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard err == noErr else { AudioHardwareDestroyProcessTap(tapID); fail("建立聚集裝置失敗（OSStatus \(err)）") }

func cleanupDevices() {
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
}

// 輸入端的串流配置：哪幾個 buffer 是 tap、哪幾個是麥克風
// 聚集裝置的輸入串流順序 = 子裝置（麥克風）在前、tap 在後
func inputStreamChannels(_ dev: AudioObjectID) -> [Int] {
    var a = addr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(dev, &a, 0, nil, &size, raw) == noErr else { return [] }
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        .map { Int($0.mNumberChannels) }
}
let layout = inputStreamChannels(aggID)
let sampleRate = getValue(aggID, kAudioDevicePropertyNominalSampleRate, Float64(0)) ?? 48000
log("取樣率 \(Int(sampleRate)) Hz，輸入串流聲道數 \(layout)")
guard !layout.isEmpty else { cleanupDevices(); fail("聚集裝置沒有輸入串流") }

// tap 是最後一個串流（立體聲）；前面的都是麥克風
let tapIndex = layout.count - 1
let micIndices = Array(0..<tapIndex)

// ---------- 2b. 即時字幕（--transcribe 才啟用） ----------
// 一路聲音一個 SpeechTranscriber：對方＝電腦聲音、我＝麥克風。只輸出定稿（isFinal）的句子。
// 2026-11-13 實測：約每 15 秒定稿一段、比實際講話晚 10～20 秒；英文術語常聽錯，所以錄完再用 whisper 精修。
final class LiveTranscriber: @unchecked Sendable {
    let who: String
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    let cont: AsyncStream<AnalyzerInput>.Continuation
    let inFormat: AVAudioFormat
    let outFormat: AVAudioFormat
    let converter: AVAudioConverter
    var reader: Task<Void, Never>?

    init(who: String, sampleRate: Double) async throws {
        self.who = who
        transcriber = SpeechTranscriber(locale: Locale(identifier: "zh-TW"), transcriptionOptions: [],
                                        reportingOptions: [], attributeOptions: [.audioTimeRange])
        analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              let inF = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inF, to: f) else {
            throw NSError(domain: "course-recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "語音辨識格式不支援"])
        }
        outFormat = f; inFormat = inF; converter = conv
        let (stream, c) = AsyncStream.makeStream(of: AnalyzerInput.self)
        cont = c
        try await analyzer.start(inputSequence: stream)
        let tr = transcriber, w = who
        reader = Task {
            do {
                for try await r in tr.results where r.isFinal {
                    let text = String(r.text.characters)
                        .replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
                        .trimmingCharacters(in: .whitespaces)
                    if text.isEmpty { continue }
                    emit(String(format: "SEG\t%@\t%.2f\t%.2f\t%@", w, r.range.start.seconds, r.range.end.seconds, text))
                }
            } catch {
                log("即時辨識（\(w)）中斷：\(error)")
                emit("LIVE_STOPPED \(w)")   // 錄音不受影響，錄完的 whisper 精修仍會產生完整逐字稿
            }
        }
    }

    // 在 feedQueue 上呼叫（不在即時執行緒）
    func feed(_ samples: [Float]) {
        guard !samples.isEmpty,
              let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        inBuf.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { inBuf.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        let cap = AVAudioFrameCount(Double(samples.count) * outFormat.sampleRate / inFormat.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
        var given = false
        var e: NSError?
        converter.convert(to: out, error: &e) { _, st in
            if given { st.pointee = .noDataNow; return nil }
            given = true; st.pointee = .haveData; return inBuf
        }
        if out.frameLength > 0 { cont.yield(AnalyzerInput(buffer: out)) }
    }

    func finish() async {
        cont.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        await reader?.value
    }
}

// 單一寫入者（錄音的即時執行緒）、單一讀取者（feedQueue）的環狀緩衝區。
// 即時執行緒只做 memcpy 和一次原子寫入：不配置記憶體、不上鎖、不派工作，避免錄音出現斷音。
final class Ring: @unchecked Sendable {
    let cap: Int
    let buf: UnsafeMutablePointer<Float>
    let written = Atomic<Int>(0)   // 累計寫入的取樣數（只增不減）
    var readPos = 0                // 只有讀取端用
    var dropped = 0
    init(capacity: Int) {
        cap = capacity
        buf = UnsafeMutablePointer<Float>.allocate(capacity: capacity)
        buf.initialize(repeating: 0, count: capacity)
    }
    @inline(__always) func write(_ src: UnsafePointer<Float>, _ n: Int) {
        guard n > 0, n <= cap else { return }
        let total = written.load(ordering: .relaxed)
        let pos = total % cap
        let first = min(n, cap - pos)
        memcpy(buf + pos, src, first * 4)
        if first < n { memcpy(buf, src + first, (n - first) * 4) }
        written.store(total + n, ordering: .releasing)
    }
    func drain() -> [Float] {
        let total = written.load(ordering: .acquiring)
        var avail = total - readPos
        if avail <= 0 { return [] }
        if avail > cap { dropped += avail - cap; readPos = total - cap; avail = cap }   // 讀太慢：丟掉最舊的
        var out = [Float](repeating: 0, count: avail)
        let pos = readPos % cap
        let first = min(avail, cap - pos)
        out.withUnsafeMutableBufferPointer { o in
            memcpy(o.baseAddress!, buf + pos, first * 4)
            if first < avail { memcpy(o.baseAddress! + first, buf, (avail - first) * 4) }
        }
        readPos = total
        return out
    }
}

// 16 kHz 單聲道 WAV（whisper 吃的格式）；寫入端吃 Float32 單聲道、原始取樣率，由 ExtAudioFile 轉換
func makeWav(_ url: URL) -> ExtAudioFileRef? {
    var ff = AudioStreamBasicDescription(mSampleRate: 16000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 2,
        mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var cf = AudioStreamBasicDescription(mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
        mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
    var ref: ExtAudioFileRef?
    guard ExtAudioFileCreateWithURL(url as CFURL, kAudioFileWAVEType, &ff, nil,
                                    AudioFileFlags.eraseFile.rawValue, &ref) == noErr, let r = ref else { return nil }
    ExtAudioFileSetProperty(r, kExtAudioFileProperty_ClientDataFormat,
                            UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &cf)
    ExtAudioFileWriteAsync(r, 0, nil)
    return r
}

var courseWav: ExtAudioFileRef? = nil
var micWav: ExtAudioFileRef? = nil
var live: [LiveTranscriber] = []
let feedQueue = DispatchQueue(label: "course-recorder.feed")
if let dir = transcribeDir {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    courseWav = makeWav(dir.appendingPathComponent("course.wav"))
    if useMic { micWav = makeWav(dir.appendingPathComponent("mic.wav")) }
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            live.append(try await LiveTranscriber(who: "對方", sampleRate: sampleRate))
            if useMic { live.append(try await LiveTranscriber(who: "我", sampleRate: sampleRate)) }
        } catch {
            log("即時字幕無法啟動：\(error)")
            emit("LIVE_FAILED \(error.localizedDescription)")
        }
        sem.signal()
    }
    sem.wait()
}
let liveOther = live.first { $0.who == "對方" }
let liveMe = live.first { $0.who == "我" }
// 即時字幕的聲音：即時執行緒寫進環狀緩衝區，feedQueue 每 0.2 秒整批取出送去辨識（緩衝 10 秒）
let courseRing: Ring? = liveOther != nil ? Ring(capacity: Int(sampleRate) * 10) : nil
let micRing: Ring? = liveMe != nil ? Ring(capacity: Int(sampleRate) * 10) : nil
func drainLive() {
    if let r = courseRing { liveOther?.feed(r.drain()) }
    if let r = micRing { liveMe?.feed(r.drain()) }
}
let feedTimer = DispatchSource.makeTimerSource(queue: feedQueue)
if !live.isEmpty {
    feedTimer.schedule(deadline: .now() + 0.2, repeating: 0.2, leeway: .milliseconds(50))
    feedTimer.setEventHandler { drainLive() }
    feedTimer.resume()
}

// ---------- 3. 輸出檔：AAC 立體聲，寫入端吃 Float32 交錯 ----------
var fileFormat = AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0, mBytesPerPacket: 0,
    mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: 2, mBitsPerChannel: 0, mReserved: 0)
var clientFormat = AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 8,
    mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
var extFile: ExtAudioFileRef?
err = ExtAudioFileCreateWithURL(outURL as CFURL, kAudioFileM4AType, &fileFormat, nil,
                                AudioFileFlags.eraseFile.rawValue, &extFile)
guard err == noErr, let file = extFile else { cleanupDevices(); fail("建立輸出檔失敗（OSStatus \(err)）：\(outURL.path)") }
ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat,
                        UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &clientFormat)
var codec: AudioConverterRef?
var codecSize = UInt32(MemoryLayout<AudioConverterRef?>.size)
if ExtAudioFileGetProperty(file, kExtAudioFileProperty_AudioConverter, &codecSize, &codec) == noErr, let c = codec {
    var br = bitRate
    AudioConverterSetProperty(c, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &br)
    var nilConfig: CFArray? = nil
    ExtAudioFileSetProperty(file, kExtAudioFileProperty_ConverterConfig,
                            UInt32(MemoryLayout<CFArray?>.size), &nilConfig)
}
ExtAudioFileWriteAsync(file, 0, nil)  // 先在非即時執行緒初始化非同步寫入

// ---------- 4. 即時回呼：混音 → 寫檔 ----------
let maxFrames = 16384
let mixBuf = UnsafeMutablePointer<Float>.allocate(capacity: maxFrames * 2)
let courseMono = UnsafeMutablePointer<Float>.allocate(capacity: maxFrames)   // 字幕用：電腦聲音（左右平均）
let micMono = UnsafeMutablePointer<Float>.allocate(capacity: maxFrames)      // 字幕用：麥克風
var peakTap: Float = 0, peakMic: Float = 0, limitedSamples = 0, writeErrors = 0
let framesTotal = Atomic<Int>(0)   // 已寫入的取樣數；主執行緒的看門狗也會讀
// 收音中斷的總時間：中斷期間沒有資料進檔案，錄音檔的時間軸會比牆上時鐘短這麼多。
// 外掛用它把截圖的時間換算回錄音檔的時間。
let lastCallbackNanos = Atomic<UInt64>(0)
let firstCallbackNanos = Atomic<UInt64>(0)   // 錄音檔第 0 秒的時間點（對齊錄影用）
let gapNanos = Atomic<UInt64>(0)
var announced = false   // 第一次真的收到聲音資料時通知外掛（AirPods 切通話模式要好幾秒）
let startedAt = Date()

// 這個區塊跑在 Core Audio 的即時執行緒：只做運算、memcpy、ExtAudioFileWriteAsync（它就是設計給即時執行緒用的）。
// 統計值先放區域變數，結束前才寫回全域變數，避免迴圈裡每個取樣都去碰全域變數。
let ioBlock: AudioDeviceIOBlock = { _, inInput, _, _, _ in
    let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInput))
    guard list.count > tapIndex else { return }
    let tapBuf = list[tapIndex]
    let tapCh = max(Int(tapBuf.mNumberChannels), 1)
    let frames = min(Int(tapBuf.mDataByteSize) / (4 * tapCh), maxFrames)
    guard frames > 0, let tapData = tapBuf.mData?.assumingMemoryBound(to: Float.self) else { return }
    let nowNanos = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    let prevNanos = lastCallbackNanos.exchange(nowNanos, ordering: .relaxed)
    if prevNanos == 0 { firstCallbackNanos.store(nowNanos, ordering: .relaxed) }
    if prevNanos != 0 && nowNanos > prevNanos + 1_000_000_000 { gapNanos.add(nowNanos - prevNanos, ordering: .relaxed) }
    var pTap: Float = 0, pMic: Float = 0, limited = 0, errors = 0
    for f in 0..<frames {
        let l = tapData[f * tapCh]
        let r = tapCh > 1 ? tapData[f * tapCh + 1] : l
        mixBuf[f * 2] = l
        mixBuf[f * 2 + 1] = r
        courseMono[f] = (l + r) * 0.5
        micMono[f] = 0
        pTap = max(pTap, abs(l), abs(r))
    }
    for i in micIndices {
        let mb = list[i]
        let ch = max(Int(mb.mNumberChannels), 1)
        guard let md = mb.mData?.assumingMemoryBound(to: Float.self) else { continue }
        let n = min(Int(mb.mDataByteSize) / (4 * ch), frames)
        for f in 0..<n {
            let v = md[f * ch] * micGain   // 麥克風取第一聲道，左右都放
            mixBuf[f * 2] += v
            mixBuf[f * 2 + 1] += v
            micMono[f] += v
            pMic = max(pMic, abs(v))
        }
    }
    for i in 0..<(frames * 2) where abs(mixBuf[i]) > 0.8 {
        mixBuf[i] = softLimit(mixBuf[i])
        limited += 1
    }
    var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
        mNumberChannels: 2, mDataByteSize: UInt32(frames * 8), mData: mixBuf))
    if ExtAudioFileWriteAsync(file, UInt32(frames), &abl) != noErr { errors += 1 }
    if let w = courseWav {
        var b = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: courseMono))
        if ExtAudioFileWriteAsync(w, UInt32(frames), &b) != noErr { errors += 1 }
    }
    if let w = micWav {
        var b = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(frames * 4), mData: micMono))
        if ExtAudioFileWriteAsync(w, UInt32(frames), &b) != noErr { errors += 1 }
    }
    courseRing?.write(courseMono, frames)
    micRing?.write(micMono, frames)
    if pTap > peakTap { peakTap = pTap }
    if pMic > peakMic { peakMic = pMic }
    if limited > 0 { limitedSamples += limited }
    if errors > 0 { writeErrors += errors }
    framesTotal.add(frames, ordering: .relaxed)
    if !announced {
        announced = true
        DispatchQueue.main.async {
            log(String(format: "● 開始收音（按下後等了 %.1f 秒）", Date().timeIntervalSince(startedAt)))
            emit("AUDIO")  // 給外掛：真的開始收到聲音
        }
    }
}

// 保持收音：自己對輸出裝置持續播放「無聲」。
// 2026-11-13 實測：只有被排除的程式（Teams）在發聲時，tap 會整個停住、聚集裝置不跑，連麥克風都錄不到；
// 換成用麥克風當時脈也一樣。讓本程式自己成為一個「正在播放、沒被排除」的程式，tap 就會持續送資料。
var silentProcID: AudioDeviceIOProcID?
let silentBlock: AudioDeviceIOBlock = { _, _, _, outOutput, _ in
    for b in UnsafeMutableAudioBufferListPointer(outOutput) {
        if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) }
    }
}
if AudioDeviceCreateIOProcIDWithBlock(&silentProcID, outDev, nil, silentBlock) == noErr, let sp = silentProcID {
    AudioDeviceStart(outDev, sp)
}
func stopSilent() {
    if let sp = silentProcID { AudioDeviceStop(outDev, sp); AudioDeviceDestroyIOProcID(outDev, sp) }
}

var procID: AudioDeviceIOProcID?
err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil, ioBlock)
guard err == noErr, let proc = procID else { cleanupDevices(); fail("建立錄音回呼失敗（OSStatus \(err)）") }
err = AudioDeviceStart(aggID, proc)
guard err == noErr else { cleanupDevices(); fail("開始錄音失敗（OSStatus \(err)）") }
log("已啟動，等待聲音：\(outURL.path)")
emit(live.isEmpty ? "STARTED" : "STARTED LIVE")  // 給外掛：錄音程式已經啟動（LIVE＝即時字幕有開）

// ---------- 7. 螢幕錄影（--video 才啟用） ----------
// 用 macOS 的 ScreenCaptureKit：系統選擇視窗（SCContentSharingPicker）選 App／視窗，SCRecordingOutput 直接寫 mp4。
// 只錄選到的 App；被其他視窗擋住也錄得到；通知、其他 App 不會入鏡。聲音不在這裡錄（錄音那邊已經有），錄完由外掛合進影片。
final class VideoRecorder: NSObject, SCContentSharingPickerObserver, SCStreamDelegate, SCRecordingOutputDelegate, @unchecked Sendable {
    let url: URL
    var stream: SCStream?
    var output: SCRecordingOutput?
    var startNanos: UInt64 = 0
    var state = "picking"            // picking → starting → recording → stopped／cancelled／failed
    var onFinished: (() -> Void)?

    init(url: URL) { self.url = url }

    func present() {
        let picker = SCContentSharingPicker.shared
        var cfg = SCContentSharingPickerConfiguration()
        cfg.allowedPickerModes = [.singleApplication, .singleWindow]
        cfg.allowsChangingSelectedContent = true
        picker.defaultConfiguration = cfg
        picker.maximumStreamCount = 1
        picker.add(self)
        picker.isActive = true
        NSApp.activate(ignoringOtherApps: true)
        picker.present()
        emit("VIDEO_PICKING")
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        DispatchQueue.main.async {
            guard self.state == "picking" else { return }
            self.state = "cancelled"
            picker.isActive = false
            emit("VIDEO_CANCELLED")
        }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        DispatchQueue.main.async {
            self.state = "failed"
            emit("VIDEO_FAILED \(error.localizedDescription)")
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        DispatchQueue.main.async {
            if let s = self.stream {   // 錄影中從選單列換了要錄的 App
                s.updateContentFilter(filter) { _ in }
                return
            }
            guard self.state == "picking" else { return }
            self.startCapture(filter)
        }
    }

    func startCapture(_ filter: SCContentFilter) {
        let scale = Double(filter.pointPixelScale)
        var w = Double(filter.contentRect.width) * scale, h = Double(filter.contentRect.height) * scale
        if w <= 0 || h <= 0 { w = 1920; h = 1080 }
        let k = min(1.0, 1920.0 / w, 1080.0 / h)
        let cfg = SCStreamConfiguration()
        cfg.width = max(2, Int(w * k) / 2 * 2)
        cfg.height = max(2, Int(h * k) / 2 * 2)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 5)   // 投影片為主：每秒 5 格
        cfg.showsCursor = true
        cfg.capturesAudio = false
        cfg.queueDepth = 6
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        let rc = SCRecordingOutputConfiguration()
        rc.outputURL = url
        rc.outputFileType = .mp4
        if rc.availableVideoCodecTypes.contains(.hevc) { rc.videoCodecType = .hevc }
        let ro = SCRecordingOutput(configuration: rc, delegate: self)
        do { try s.addRecordingOutput(ro) } catch {
            state = "failed"
            emit("VIDEO_FAILED \(error.localizedDescription)")
            return
        }
        stream = s
        output = ro
        state = "starting"
        log("錄影：\(cfg.width)×\(cfg.height)，每秒 5 格 → \(url.path)")
        s.startCapture { err in
            guard let err else { return }
            DispatchQueue.main.async {
                self.state = "failed"
                self.stream = nil
                emit("VIDEO_FAILED \(err.localizedDescription)")
            }
        }
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        DispatchQueue.main.async {
            self.state = "recording"
            self.startNanos = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
            emit("VIDEO_STARTED \(self.url.path)")
        }
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        DispatchQueue.main.async {
            log("錄影失敗：\(error)")
            emit("VIDEO_FAILED \(error.localizedDescription)")
            self.state = "failed"
            self.done()
        }
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        DispatchQueue.main.async {
            emit("VIDEO_SAVED \(self.url.path)")
            self.state = "stopped"
            self.done()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            log("錄影中斷：\(error)")
            emit("VIDEO_STOPPED \(error.localizedDescription)")   // 例如被錄的 App 結束了；錄音照常
        }
    }

    private func done() {
        if let f = onFinished { onFinished = nil; f() }
    }

    // 停止：等檔案寫完再呼叫 completion（最多 10 秒）
    func stop(_ completion: @escaping () -> Void) {
        let picker = SCContentSharingPicker.shared
        picker.isActive = false
        picker.remove(self)
        guard let s = stream, state == "recording" || state == "starting" else { completion(); return }
        onFinished = completion
        s.stopCapture { _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            if self.onFinished != nil { log("錄影收尾逾時"); self.done() }
        }
    }
}

var video: VideoRecorder? = nil
var offsetSent = false
// 錄影的第 0 秒是錄音的第幾秒；兩邊都開始了才知道
func emitVideoOffset() {
    guard !offsetSent, let v = video, v.startNanos > 0 else { return }
    let a = firstCallbackNanos.load(ordering: .relaxed)
    guard a > 0 else { return }
    offsetSent = true
    emit(String(format: "VIDEO_OFFSET %.3f", (Double(v.startNanos) - Double(a)) / 1e9))
}

// ---------- 5. 收到 SIGINT／SIGTERM 就收尾 ----------
var finishing = false
func finish(_ reason: String = "") {
    if finishing { return }
    finishing = true
    if !reason.isEmpty { log("收尾原因：\(reason)") }
    emitVideoOffset()
    // 先讓錄影把檔案寫完（最多 10 秒），再收錄音
    if let v = video { v.stop { finishAudio() } } else { finishAudio() }
}
func finishAudio() {
    AudioDeviceStop(aggID, proc)
    AudioDeviceDestroyIOProcID(aggID, proc)
    stopSilent()
    ExtAudioFileDispose(file)   // 先把錄音檔收好，後面的步驟就算出事也不會弄壞它
    if let w = courseWav { ExtAudioFileDispose(w) }
    if let w = micWav { ExtAudioFileDispose(w) }
    cleanupDevices()
    let frames = framesTotal.load(ordering: .relaxed)
    let secs = Double(frames) / sampleRate
    if frames == 0 {
        try? FileManager.default.removeItem(at: outURL)
        if let d = transcribeDir { try? FileManager.default.removeItem(at: d) }
        log("■ 沒有收到任何聲音，已刪除空檔案")
        emit("EMPTY")
        exit(0)
    }
    var summary = String(format: "■ 已存檔：%.1f 秒，系統聲音峰值 %.3f、麥克風峰值 %.3f、防爆音作用 %d 個取樣", secs, peakTap, peakMic, limitedSamples)
    if writeErrors > 0 { summary += "、⚠️ 寫檔失敗 \(writeErrors) 次（磁碟太慢，錄音可能有缺漏）" }
    log(summary)
    let done = { emit("SAVED \(outURL.path)"); exit(0) }
    if live.isEmpty { done(); return }
    // 等即時辨識把最後一段定稿吐出來；最多等 30 秒
    log("等即時字幕收尾…")
    feedTimer.cancel()
    feedQueue.sync { drainLive() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { log("即時字幕收尾逾時"); done() }
    Task {
        for l in live { await l.finish() }
        DispatchQueue.main.async { done() }
    }
}
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigSources = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler { finish("收到停止訊號") }
    s.resume()
    return s
}
// 保險：最長 4 小時自動停止，避免忘了停一直錄
DispatchQueue.main.asyncAfter(deadline: .now() + 4 * 3600) { finish("已錄滿 4 小時") }

// ---------- 6. 看門狗：每 2 秒檢查一次 ----------
// (a) 啟動它的程式（Obsidian）不見了 → 自己收尾存檔，不要變成沒人管的錄音
// (b) 開始收音後連續 6 秒沒有新資料 → 多半是耳機斷線或裝置被換掉，通知外掛；恢復時也通知
// (c) 取樣率中途改變 → 警告（檔案是照一開始的取樣率寫的）
var lastFrames = 0, stalledTicks = 0, stalled = false, rateWarned = false, micWarned = false
let watchdog = DispatchSource.makeTimerSource(queue: .main)
watchdog.schedule(deadline: .now() + 2, repeating: 2)
watchdog.setEventHandler {
    if finishing { return }
    emitVideoOffset()
    if getppid() != parentPID { finish("啟動錄音的程式已經結束"); return }
    let now = framesTotal.load(ordering: .relaxed)
    if now > 0 && now == lastFrames {
        stalledTicks += 1
        if stalledTicks == 3 && !stalled { stalled = true; log("⚠️ 收音中斷"); emit("STALLED") }
    } else {
        if stalled {
            stalled = false
            let gap = Double(gapNanos.load(ordering: .relaxed)) / 1e9
            log(String(format: "收音恢復（累計中斷 %.1f 秒）", gap))
            emit(String(format: "RESUMED %.1f", gap))
        }
        stalledTicks = 0
    }
    lastFrames = now
    // (d) 錄了 10 秒，麥克風一點聲音都沒有（數位靜音）→ 多半是盒蓋時的內建麥克風，或耳機沒連上
    //     2026-11-13 實測：AirPods 沒連時系統自動換成 MacBook 內建麥克風，盒蓋時錄到的峰值是 0.000
    if !micWarned && useMic && Double(now) / sampleRate >= 10 && peakMic == 0 {
        micWarned = true
        log("⚠️ 麥克風 10 秒都是靜音：\(micName)")
        emit("WARN 麥克風「\(micName)」10 秒都沒有聲音，你的聲音可能錄不到（螢幕蓋著時內建麥克風會被切斷；AirPods 有連上嗎？）。電腦的聲音照常在錄")
    }
    if !rateWarned, let r = getValue(aggID, kAudioDevicePropertyNominalSampleRate, Float64(0)), r > 0, r != sampleRate {
        rateWarned = true
        log("⚠️ 取樣率從 \(Int(sampleRate)) 變成 \(Int(r))")
        emit("WARN 音訊裝置的取樣率中途改變（\(Int(sampleRate))→\(Int(r)) Hz），這段錄音的速度可能不對，建議停止後重新開始")
    }
}
watchdog.resume()

// 測試用：COURSE_REC_TEST_STALL=<秒> 會在那個時間點停掉收音 8 秒再恢復，用來驗證 (b)
if let v = ProcessInfo.processInfo.environment["COURSE_REC_TEST_STALL"], let t = Double(v) {
    DispatchQueue.main.asyncAfter(deadline: .now() + t) {
        log("測試：停掉收音 8 秒"); AudioDeviceStop(aggID, proc)
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { if !finishing { AudioDeviceStart(aggID, proc) } }
    }
}
_ = sigSources
if let vu = videoURL {
    // 選擇視窗是系統的 UI，要有 NSApplication 的執行迴圈；不出現在 Dock
    try? FileManager.default.createDirectory(at: vu.deletingLastPathComponent(), withIntermediateDirectories: true)
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    video = VideoRecorder(url: vu)
    DispatchQueue.main.async { video?.present() }
    app.run()
} else {
    dispatchMain()
}
