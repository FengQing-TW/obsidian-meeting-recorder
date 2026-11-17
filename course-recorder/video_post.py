#!/usr/bin/env python3
"""錄完後處理螢幕錄影：(1) 把錄音合進影片 (2) 偵測投影片換頁，每一頁截一張圖。

用法：python3 -I video_post.py <錄影.mp4> <錄音.m4a> <輸出資料夾> <offset 秒>
  offset：錄影第 0 秒＝錄音第幾秒（錄音程式的 VIDEO_OFFSET；錄影通常比錄音晚開始，所以多半是正數）
輸出（stdout）：JSON {"muxed": true/false, "truncated": 是否超過 300 頁被截斷, "slides": [{"t": 錄音的秒數, "file": 截圖路徑}, …]}
進度與錯誤寫到 stderr。由 Obsidian 外掛「錄音筆記（本機）」用 /usr/bin/python3（Apple 內建 3.9）執行。

換頁偵測（不需要 numpy）：
- 每秒取一格，縮成 32×18 格的灰階（每格是原畫面一小塊的平均亮度），比的是「有幾格變了」
  （2026-11-13 實測：比整張畫面的平均差異不行——白底投影片只有文字在變，換頁的平均差異只有 6～7，
   跟角落一個小視訊在動差不多）
- 整場錄影裡超過 3 成時間都在動的格子（會議視窗裡的人像、時鐘）連同周圍一格先排除，不參與判斷
- 剩下的格子跟「上一張截下來的頁面」比，有 8 格以上變了、而且接下來 2 秒畫面穩定（變動不超過 3 格）
  → 算一張新投影片，截原尺寸 JPEG
- 整個畫面都在動（播影片）就一直不穩定 → 不會截圖
說明：README.md 與 docs/使用說明.md
"""
import json
import os
import subprocess
import sys

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
W, H = 32, 18
CELL_DIFF = 10     # 一格的亮度差超過這個（0～255）就算這格變了
ACTIVE_RATIO = 0.3 # 超過這個比例的時間都在變的格子，視為一直在動的區域，連同周圍一格一起排除
STABLE_CELLS = 3   # 相鄰兩秒變動的格子不超過這麼多 → 畫面穩定
NEW_CELLS = 8      # 跟上一張截圖相比，變動的格子至少這麼多 → 換頁了
# 2026-11-13 合成影片實測（1920×1080、右下角有 240×135 的方塊一直在動）：
#   方塊邊緣造成的變動 2～5 格、換頁 54～64 格
MIN_GAP = 3        # 兩張截圖至少隔幾秒
MAX_SLIDES = 300


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def duration(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def mux(video, audio, offset):
    """把錄音合進影片（不重新編碼）。offset > 0：錄音比錄影早開始，要跳過錄音開頭那幾秒。"""
    if not os.path.exists(audio):
        log("找不到錄音檔，影片不合聲音")
        return False
    tmp = video + ".muxing.mp4"
    cmd = [FFMPEG, "-v", "error", "-y", "-i", video]
    if offset >= 0:
        cmd += ["-ss", f"{offset:.3f}", "-i", audio]
    else:
        cmd += ["-itsoffset", f"{-offset:.3f}", "-i", audio]
    # 不加 -shortest：收音中斷過的話錄音會比錄影短，加了會把影片尾端截掉（2026-11-13 審查）
    cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0 or duration(tmp) <= 0:
        log(f"合併聲音失敗，保留沒有聲音的影片：{r.stderr[-300:]}")
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    os.replace(tmp, video)
    return True


def thumbnails(video):
    """每秒一格、32×18 灰階（area 縮圖＝每格的平均亮度）。"""
    cmd = [FFMPEG, "-v", "error", "-i", video, "-vf", f"fps=1,scale={W}:{H}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"讀不到影片畫面：{r.stderr.decode(errors='replace')[-300:]}")
    n = W * H
    data = r.stdout
    return [data[i:i + n] for i in range(0, len(data) - n + 1, n)]


def changed(a, b, cells):
    """a、b 兩格畫面之間，cells 裡有幾格變了。"""
    return sum(1 for k in cells if abs(a[k] - b[k]) > CELL_DIFF)


def pick_slides(frames):
    """回傳要截圖的秒數。"""
    n = len(frames)
    if n < 3:
        return ([0] if n else []), False
    allcells = range(W * H)
    # 一直在動的格子
    active = [0] * (W * H)
    for i in range(n - 1):
        a, b = frames[i], frames[i + 1]
        for k in allcells:
            if abs(a[k] - b[k]) > CELL_DIFF:
                active[k] += 1
    masked = set()
    if n >= 20:
        for k in allcells:
            if active[k] > ACTIVE_RATIO * (n - 1):
                x, y = k % W, k // W
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        if 0 <= x + dx < W and 0 <= y + dy < H:
                            masked.add((y + dy) * W + x + dx)
    cells = [k for k in allcells if k not in masked]
    if not cells:
        return [], False
    moving = [changed(frames[i], frames[i + 1], cells) for i in range(n - 1)]
    picks, last, truncated = [], None, False
    for i in range(n - 2):
        if moving[i] > STABLE_CELLS or moving[i + 1] > STABLE_CELLS:
            continue   # 還在動（換頁動畫、捲動、播影片）
        if last is not None and (i - picks[-1] < MIN_GAP or changed(frames[i], last, cells) < NEW_CELLS):
            continue
        if len(picks) >= MAX_SLIDES:
            truncated = True   # 還有新的一頁但已達上限：要讓使用者知道後面沒截
            break
        picks.append(i)
        last = frames[i]
    log(f"畫面 {W}×{H} 格，排除一直在動的 {W * H - len(cells)} 格")
    return picks, truncated


def grab(video, sec, out):
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{sec + 0.5:.2f}", "-i", video,
                        "-frames:v", "1", "-q:v", "3", out], capture_output=True)
    return r.returncode == 0 and os.path.exists(out)


def main():
    if len(sys.argv) != 5:
        sys.exit("用法：video_post.py <錄影.mp4> <錄音.m4a> <輸出資料夾> <offset 秒>")
    video, audio, outdir, offset = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    if not os.path.exists(video) or duration(video) <= 0:
        raise RuntimeError(f"錄影檔不存在或是空的：{video}")
    os.makedirs(outdir, exist_ok=True)
    muxed = mux(video, audio, offset)
    frames = thumbnails(video)
    picks, truncated = pick_slides(frames)
    log(f"影片 {len(frames)} 秒，偵測到 {len(picks)} 頁")
    slides = []
    for n, sec in enumerate(picks, 1):
        out = os.path.join(outdir, f"slide-{n:03d}.jpg")
        if grab(video, sec, out):
            slides.append({"t": round(max(0.0, sec + offset), 2), "file": out})
    json.dump({"muxed": muxed, "truncated": truncated, "slides": slides}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — 錯誤訊息要給外掛顯示
        log(f"錯誤：{e}")
        sys.exit(1)
