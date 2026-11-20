#!/usr/bin/env python3
"""錄完後的 whisper 精修：把 course.wav（對方）和 mic.wav（我）各跑一次 whisper，合併成一份逐字稿。

用法：python3 -I transcribe.py <暫存資料夾>
輸出（stdout）：JSON 陣列 [{"who": "對方", "start": 秒, "end": 秒, "text": "…"}, …]，依時間排序
進度與錯誤寫到 stderr。由 Obsidian 外掛「錄音筆記（本機）」用 /usr/bin/python3（Apple 內建 3.9）執行。

流程：
1. 先掃一遍音量（每 0.1 秒一格），找出「有人講話」的區段，間隔 10 秒內的接成一個「塊」。
   - 整軌幾乎沒聲音（例如整場都沒開口的麥克風）→ 直接跳過，不跑 whisper
   - 每一塊各跑一次 whisper（-ot/-d 指定範圍，時間是原檔的絕對時間），長靜音完全不送進去
     （省時間，也避免 whisper 在長靜音裡幻想出句子、或時間碼漂掉）
   - 2026-11-13 實測過「把有聲區段剪接成一個檔再辨識」：接縫後面的內容會整段不見，所以不這樣做
   - 跑完檢查兩件事，有問題的範圍單獨重跑（不帶提示詞）：
     (a) 有聲區段裡有 4 秒以上沒有任何逐字稿
     (b) 一個片段蓋了很長的有聲時間、字卻很少。2026-11-13 實測：帶提示詞時，whisper 偶爾會把一大段
         併成一個片段、漏掉其中的內容（同一句話講兩次只出現一次）；不帶提示詞重跑就正常
2. whisper.cpp large-v3-turbo，-l zh。暫存資料夾有 hints.txt（錄音中貼的截圖辨識出的文字）時，
   挑英文術語加進提示詞，並用 --carry-initial-prompt 讓提示詞在整段錄音都有效
3. 丟掉落在靜音上的片段與已知的幻覺句；opencc s2twp 轉台灣繁體用字；中文旁邊的半形標點改全形
4. 同一個人、間隔 1.5 秒內的相鄰片段合成一段（最長約 120 字）；遇到截圖／投影片的時間點（breaks.json）就斷開，
   讓圖接在它那段話的前面，不會被一大段話擠到後面
說明：README.md 與 docs/使用說明.md
"""
import json
import math
import os
import re
import struct
import subprocess
import sys
import wave

try:
    import audioop  # Python 3.12 以前內建；用 C 算音量，比純 Python 快上百倍
except ImportError:  # pragma: no cover — 3.13 以後沒有 audioop
    audioop = None

HOME = os.path.expanduser("~")
WHISPER = "/opt/homebrew/bin/whisper-cli"
OPENCC = "/opt/homebrew/bin/opencc"
MODEL = os.path.join(HOME, "Library/Application Support/whisper.cpp/models/ggml-large-v3-turbo.bin")
PROMPT = "以下是繁體中文的會議或課程內容，可能夾雜英文術語。"
HALLUCINATIONS = ("字幕由", "Amara.org", "點贊", "點讚", "訂閱轉發", "明鏡與點點", "請不吝", "字幕志願者",
                  "謝謝觀看", "感謝觀看", "谢谢观看", "感谢观看")
MERGE_GAP = 1.5
MERGE_MAX_CHARS = 120
STOPWORDS = {"the", "and", "for", "with", "from", "this", "that", "are", "was", "you", "your", "not",
             "but", "can", "will", "all", "has", "have", "into", "use", "using", "via", "per"}
MAX_TERMS = 40

WIN = 0.1                 # 音量分析的格子大小（秒）
SEGMENT_SILENCE_DBFS = -48.0   # whisper 片段的平均音量低於這個就當成幻覺丟掉
VAD_PAD = 0.3             # 有聲區段前後各多留這麼多
VAD_JOIN_GAP = 0.8        # 兩個有聲區段的間隔小於這個就接成一段
MIN_SPEECH = 1.0          # 整軌有聲音的時間不到這麼多 → 不跑 whisper
CHUNK_JOIN_GAP = 10.0     # 有聲區段間隔在這以內 → 同一塊（一次 whisper）；每多一塊要多載入一次模型（約 1 秒）
MAX_CHUNKS = 60           # 塊數超過就把間隔門檻加倍再併，避免載入模型的時間比辨識還久
UNCOVERED_RETRY = 4.0     # 有聲區段裡連續這麼久沒有逐字稿 → 單獨重跑
SPARSE_MIN_SPEECH = 8.0   # 一個片段蓋住這麼久的有聲時間，字數卻…
SPARSE_DENSITY = 2.2      # …不到每秒這麼多音節（正常講話每秒 4～5 個）→ 多半漏了內容，單獨重跑
MAX_RETRIES = 20


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------- WAV 讀取：自己找 data 區塊，不靠檔頭裡的長度 ----------
# 錄音程式被強制結束時，檔頭的長度欄位來不及寫回（會是 0），但聲音資料都在；
# Apple 寫的 WAV 在 data 前面還有一個 FLLR 填充區塊。所以這裡用檔案大小推算長度。
class Track:
    def __init__(self, path):
        self.path = path
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(min(size, 65536))
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError(f"{os.path.basename(path)} 不是 WAV 檔")
        pos, self.rate, self.data_off, declared = 12, 16000, None, 0
        while pos + 8 <= len(head):
            cid, csize = head[pos:pos + 4], struct.unpack("<I", head[pos + 4:pos + 8])[0]
            if cid == b"fmt ":
                fmt, ch, self.rate, _, _, bits = struct.unpack("<HHIIHH", head[pos + 8:pos + 24])
                if fmt != 1 or ch != 1 or bits != 16:
                    raise ValueError(f"{os.path.basename(path)} 需要 16-bit 單聲道 PCM")
            elif cid == b"data":
                self.data_off, declared = pos + 8, csize
                break
            pos += 8 + csize + (csize & 1)
        if self.data_off is None:
            raise ValueError(f"{os.path.basename(path)} 找不到聲音資料")
        actual = (size - self.data_off) // 2
        self.header_ok = 0 < declared <= size - self.data_off
        self.frames = declared // 2 if self.header_ok else actual
        self.duration = self.frames / self.rate

    def read(self, start_frame, n_frames):
        start_frame = max(0, min(start_frame, self.frames))
        n_frames = max(0, min(n_frames, self.frames - start_frame))
        with open(self.path, "rb") as f:
            f.seek(self.data_off + start_frame * 2)
            return f.read(n_frames * 2)


def rms_dbfs(pcm):
    if len(pcm) < 2:
        return -math.inf
    if audioop is not None:
        r = audioop.rms(pcm, 2)
    else:
        vals = struct.unpack(f"<{len(pcm) // 2}h", pcm[:len(pcm) // 2 * 2])
        r = math.sqrt(sum(v * v for v in vals) / len(vals))
    return -math.inf if r <= 0 else 20 * math.log10(r / 32768.0)


def window_levels(track):
    """每 WIN 秒一格的音量（dBFS）。一次讀 30 秒，不把整個檔案放進記憶體。"""
    win = int(track.rate * WIN)
    chunk_frames = win * 300
    levels = []
    for start in range(0, track.frames, chunk_frames):
        pcm = track.read(start, chunk_frames)
        for off in range(0, len(pcm) - win * 2 + 1, win * 2):
            levels.append(rms_dbfs(pcm[off:off + win * 2]))
    return levels


def speech_regions(levels):
    """回傳有聲區段 [(開始秒, 結束秒), …]。門檻跟著這一軌的底噪走。"""
    finite = sorted(v for v in levels if v > -math.inf)
    if not finite:
        return []
    floor = finite[len(finite) // 10]                 # 第 10 百分位當底噪
    thr = min(-40.0, max(-55.0, floor + 10.0))        # 底噪上方 10 dB，夾在 -55～-40 dBFS
    regions, cur = [], None
    for i, v in enumerate(levels):
        if v > thr:
            t0, t1 = i * WIN, (i + 1) * WIN
            if cur and t0 - cur[1] <= VAD_JOIN_GAP:
                cur[1] = t1
            else:
                cur = [t0, t1]
                regions.append(cur)
    total = len(levels) * WIN
    out = []
    for a, b in regions:
        a, b = max(0.0, a - VAD_PAD), min(total, b + VAD_PAD)
        if out and a <= out[-1][1]:
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def speech_units(text):
    """大約的「音節數」：中文一字算 1、英文或數字一個詞算 2。用來估講話的密度。"""
    return len(re.findall(r"[\u3400-\u9fff]", text)) + 2 * len(re.findall(r"[A-Za-z0-9]+", text))


def chunks_of(regions):
    """把有聲區段併成要各跑一次 whisper 的「塊」。"""
    gap = CHUNK_JOIN_GAP
    while True:
        out = []
        for a, b in regions:
            if out and a - out[-1][1] <= gap:
                out[-1][1] = b
            else:
                out.append([a, b])
        if len(out) <= MAX_CHUNKS:
            return [(a, b) for a, b in out]
        gap *= 2


def uncovered(regions, segs):
    """有聲區段裡沒有被任何逐字稿片段蓋到、而且夠長的時間範圍。"""
    out = []
    for a, b in regions:
        t = a
        for s in sorted((s for s in segs if s["end"] > a and s["start"] < b), key=lambda s: s["start"]):
            if s["start"] - t >= UNCOVERED_RETRY:
                out.append((t, s["start"]))
            t = max(t, s["end"])
        if b - t >= UNCOVERED_RETRY:
            out.append((t, b))
    return out


def copy_fixed(track, out_path):
    """檔頭壞掉（錄音程式被強制結束）時，重寫一份檔頭正確的 WAV 給 whisper。"""
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(track.rate)
        step = track.rate * 60
        for start in range(0, track.frames, step):
            w.writeframes(track.read(start, step))


# ---------- whisper ----------
def perf_cores():
    try:
        n = int(subprocess.run(["/usr/sbin/sysctl", "-n", "hw.perflevel0.physicalcpu"],
                               capture_output=True, text=True).stdout.strip())
        return max(2, min(n, 8))
    except (ValueError, OSError):
        return 4


def hint_terms(tmpdir):
    """從截圖文字挑英文術語（中文 whisper 本來就聽得懂，最常錯的是英文專有名詞）。"""
    path = os.path.join(tmpdir, "hints.txt")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    seen, terms = set(), []
    for t in re.findall(r"[A-Za-z][A-Za-z0-9.+#/-]*[A-Za-z0-9+#]|[A-Z]{2,}", text):
        k = t.lower()
        if k in seen or k in STOPWORDS or (len(t) < 3 and not t.isupper()):
            continue
        seen.add(k)
        terms.append(t)
    return terms[:MAX_TERMS]


def build_prompt(terms):
    return PROMPT + (" 可能出現的詞：" + "、".join(terms) + "。" if terms else "")


def run_whisper(wav, out_prefix, prompt, threads, start=None, end=None):
    cmd = [WHISPER, "-m", MODEL, "-l", "zh", "-t", str(threads), "-np", "-oj", "-of", out_prefix, "-f", wav]
    if prompt:
        cmd += ["--prompt", prompt, "--carry-initial-prompt"]
    if start is not None:
        cmd += ["-ot", str(int(start * 1000)), "-d", str(int((end - start) * 1000))]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"whisper 失敗（{os.path.basename(wav)}，結束碼 {r.returncode}）：{r.stderr[-500:]}")
    # whisper.cpp 偶爾會把一個中文字切在兩個片段中間，輸出不合法的 UTF-8；用 replace 讀，不要整份失敗
    with open(out_prefix + ".json", encoding="utf-8", errors="replace") as f:
        raw = json.load(f)["transcription"]
    return [(s["offsets"]["from"] / 1000.0, s["offsets"]["to"] / 1000.0, s["text"].strip()) for s in raw]


def segments_for(wav, who, tmpdir, prompt, threads):
    if not os.path.exists(wav):
        return []
    track = Track(wav)
    if track.frames == 0:
        return []
    tag = "course" if who == "對方" else "mic"
    regions = speech_regions(window_levels(track))
    speech = sum(b - a for a, b in regions)
    if speech < MIN_SPEECH:
        log(f"whisper：{who}（{track.duration:.0f} 秒）幾乎沒有聲音，跳過")
        return []
    src = wav
    if not track.header_ok:
        src = os.path.join(tmpdir, f"fixed-{tag}.wav")
        copy_fixed(track, src)
    chunks = chunks_of(regions)
    log(f"whisper：{who}（{track.duration:.0f} 秒，有聲 {speech:.0f} 秒，分 {len(chunks)} 塊）…")
    out_prefix = os.path.join(tmpdir, "whisper-" + tag)
    segs, dropped = [], 0

    def collect(raw, lo, hi):
        nonlocal dropped
        got = []
        for start, end, text in raw:
            start, end = max(start, lo), min(max(end, start + 0.1), hi + 1.0)
            if not text or end <= start:
                continue
            pcm = track.read(int(start * track.rate), int((end - start) * track.rate))
            if rms_dbfs(pcm) < SEGMENT_SILENCE_DBFS:
                dropped += 1
                continue
            got.append({"who": who, "start": round(start, 2), "end": round(end, 2), "text": text})
        return got

    whole = len(chunks) == 1 and chunks[0][0] < 1.0 and track.duration - chunks[0][1] < 1.0
    for i, (a, b) in enumerate(chunks):
        if whole:
            raw = run_whisper(src, out_prefix, prompt, threads)
        else:
            a2, b2 = max(0.0, a - 0.2), min(track.duration, b + 0.2)
            raw = run_whisper(src, out_prefix, prompt, threads, a2, b2)
        segs += collect(raw, 0.0 if whole else a - 0.2, track.duration if whole else b + 0.2)
        if len(chunks) > 5 and (i + 1) % 5 == 0:
            log(f"whisper：{who} {i + 1}/{len(chunks)} 塊")
    # 有聲卻沒有逐字稿的地方再試一次，這次不帶提示詞（提示詞偶爾會讓 whisper 提早收尾）
    retried = 0

    def rerun(a, b):
        nonlocal retried
        retried += 1
        return collect(run_whisper(src, out_prefix, "", threads, max(0.0, a - 0.2), min(track.duration, b + 0.2)), a - 0.2, b + 0.2)

    for a, b in uncovered(regions, segs):
        if retried >= MAX_RETRIES:
            break
        segs += rerun(a, b)
    # 蓋了很長的有聲時間、字卻很少的片段：重跑後字數明顯變多才換掉
    for seg in list(segs):
        if retried >= MAX_RETRIES:
            break
        spoken = sum(max(0.0, min(seg["end"], b) - max(seg["start"], a)) for a, b in regions)
        if spoken >= SPARSE_MIN_SPEECH and speech_units(seg["text"]) / spoken < SPARSE_DENSITY:
            # 把這個片段裡的每個有聲區段各自重跑：整段一起重跑常常得到一樣的結果（實測）
            got = []
            for a, b in regions:
                a, b = max(a, seg["start"]), min(b, seg["end"])
                if b - a >= 1.0 and retried < MAX_RETRIES:
                    got += rerun(a, b)
            if sum(speech_units(g["text"]) for g in got) > speech_units(seg["text"]) * 1.2:
                segs.remove(seg)
                segs += got
    segs.sort(key=lambda s: s["start"])
    log(f"whisper：{who} 完成，{len(segs)} 段（丟掉 {dropped} 段靜音" + (f"；重跑 {retried} 處可能漏字的地方" if retried else "") + "）")
    return segs


# ---------- 文字整理 ----------
def to_traditional(texts):
    """一次轉換多行（每段一行），避免每段都開一個 opencc 程序。"""
    if not texts or not os.path.exists(OPENCC):
        return texts
    joined = "\n".join(t.replace("\n", " ") for t in texts)
    r = subprocess.run([OPENCC, "-c", "s2twp"], input=joined, capture_output=True, text=True, errors="replace")
    out = r.stdout.rstrip("\n").split("\n") if r.returncode == 0 else texts
    return out if len(out) == len(texts) else texts


CJK = r"[㐀-鿿　-〿＀-￯]"
PUNCT = {",": "，", "?": "？", "!": "！", ":": "：", ";": "；"}


def fix_punct(t):
    t = t.replace("�", "").strip()   # 不合法 UTF-8 留下的替代字元
    # 中文旁邊的半形標點改全形（英文句子裡的標點不動）
    t = re.sub(rf"(?<={CJK})\s*([,?!:;])\s*|\s*([,?!:;])\s*(?={CJK})",
               lambda m: PUNCT[m.group(1) or m.group(2)], t)
    t = re.sub(r"(?<=[。，！？：；、])\s+", "", t)   # 全形標點後面不要空格
    if re.search(CJK, t):
        t = re.sub(r"\s*,$", "，", t)                # 中文段落結尾的半形逗號（段落在這裡被截圖斷開）
    return t


def merge(segs, breaks=()):
    out = []
    for s in segs:
        p = out[-1] if out else None
        crosses = any(p and p["start"] < b <= s["start"] for b in breaks)
        if (p and not crosses and p["who"] == s["who"] and s["start"] - p["end"] <= MERGE_GAP
                and len(p["text"]) + len(s["text"]) <= MERGE_MAX_CHARS):
            sep = "" if re.search(rf"{CJK}$", p["text"]) or re.match(CJK, s["text"]) else " "
            p["text"] += sep + s["text"]
            p["end"] = s["end"]
        else:
            out.append(dict(s))
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit("用法：transcribe.py <暫存資料夾>")
    d = sys.argv[1]
    for path, what in ((WHISPER, "whisper-cli（brew install whisper-cpp）"), (MODEL, "whisper 模型 ggml-large-v3-turbo.bin")):
        if not os.path.exists(path):
            raise RuntimeError(f"找不到 {what}：{path}")
    terms = hint_terms(d)
    if terms:
        log(f"截圖詞彙提示 {len(terms)} 個：{', '.join(terms)}")
    prompt, threads = build_prompt(terms), perf_cores()
    segs = segments_for(os.path.join(d, "course.wav"), "對方", d, prompt, threads) + \
        segments_for(os.path.join(d, "mic.wav"), "我", d, prompt, threads)
    segs.sort(key=lambda s: s["start"])
    texts = to_traditional([s["text"] for s in segs])
    kept = []
    for s, t in zip(segs, texts):
        t = fix_punct(t)
        if not t or any(h in t for h in HALLUCINATIONS):
            continue
        s["text"] = t
        kept.append(s)
    breaks = []
    try:
        with open(os.path.join(d, "breaks.json"), encoding="utf-8") as f:
            breaks = sorted(float(x) for x in json.load(f))
    except (OSError, ValueError, TypeError):
        breaks = []
    merged = merge(kept, breaks)
    for s in merged:   # 片段接縫處的標點（例如前一段結尾的半形逗號）合併後再整理一次
        s["text"] = fix_punct(s["text"])
    json.dump(merged, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — 錯誤訊息要給外掛顯示
        log(f"錯誤：{e}")
        sys.exit(1)
