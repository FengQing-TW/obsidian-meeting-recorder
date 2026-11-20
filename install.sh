#!/bin/zsh
# 錄音筆記（Obsidian 外掛＋錄音程式）安裝腳本
# 用法：在這個 repo 的資料夾裡執行  zsh install.sh
# 會做的事：檢查環境 → 安裝缺的 Homebrew 套件（先問）→ 放好錄音程式並在本機重新編譯 →
#           檢查 whisper 模型（沒有就問要不要下載）→ 把外掛裝進 Obsidian vault → 列出要手動允許的權限
# 可重複執行；既有的檔案會先備份。不會動到 sudo。
# 環境變數：VAULT_DIR（vault 資料夾，沒給會問）；測試用：CONFIG_DIR、MODEL_DIR、ASSUME_YES=1（全部答是，但不會自動下載模型）
emulate -L zsh
setopt err_return no_unset pipe_fail 2>/dev/null
PKG=${0:A:h}
STAMP=$(date +%Y%m%d-%H%M%S)
CONFIG_DIR=${CONFIG_DIR:-$HOME/.config/meeting-recorder}
OLD_CONFIG_DIR=${OLD_CONFIG_DIR:-$HOME/.config/course-recorder}   # 0.12 以前的位置（0.13.0 改名）
MODEL_DIR=${MODEL_DIR:-$HOME/Library/Application Support/whisper.cpp/models}
VAULT_DIR=${VAULT_DIR:-}
BREW=/opt/homebrew/bin/brew
typeset -a WARN DONE

say()  { print -r -- "$@"; }
step() { print -r -- ""; print -r -- "▶ $1"; }
ask()  {   # ask "問題" → 回傳 0 表示同意
  [[ ${ASSUME_YES:-0} == 1 ]] && return 0
  local a; read "a?$1 [y/N] "; [[ $a == [yY]* ]]
}
backup() {   # backup <路徑>：存在就搬到同層的 .bak-時間
  [[ -e $1 ]] || return 0
  mv "$1" "$1.bak-$STAMP" && say "   既有的已備份：$1.bak-$STAMP"
}

# ---------- 1. 環境 ----------
step "檢查這台 Mac"
[[ $(uname -m) == arm64 ]] || { say "✘ 這台不是 Apple Silicon，這套工具不適用（程式和 Homebrew 路徑都是 arm64 的）"; exit 1 }
OSV=$(sw_vers -productVersion); OSMAJOR=${OSV%%.*}
say "   macOS $OSV、Apple Silicon"
HAVE_CLT=1; xcode-select -p >/dev/null 2>&1 || HAVE_CLT=0
if (( ! HAVE_CLT )); then
  say "✘ 沒有 Command Line Tools（錄音工具要用它的 python3 和 swiftc）"
  say "   請先執行：xcode-select --install  裝好後再跑一次這支腳本"
  exit 1
fi
(( OSMAJOR >= 26 )) || WARN+=("macOS $OSV 低於 26：即時字幕用的語音辨識功能這版系統沒有，錄音程式編譯會失敗")

# ---------- 2. Homebrew 套件 ----------
step "檢查 whisper-cpp、opencc、ffmpeg"
typeset -a MISSING
[[ -x /opt/homebrew/bin/whisper-cli ]] || MISSING+=(whisper-cpp)
[[ -x /opt/homebrew/bin/opencc ]]      || MISSING+=(opencc)
[[ -x /opt/homebrew/bin/ffmpeg ]]      || MISSING+=(ffmpeg)
if (( ${#MISSING} == 0 )); then
  say "   都有了"
elif [[ ! -x $BREW ]]; then
  WARN+=("沒有 Homebrew，缺：${MISSING[*]}。裝好 Homebrew（https://brew.sh）後執行：brew install ${MISSING[*]}。沒裝之前：錄音可以錄，但停止後的逐字稿精修、錄影後處理不能用")
elif ask "   缺 ${MISSING[*]}，要用 Homebrew 安裝嗎？（公司電腦請先確認規範）"; then
  HOMEBREW_NO_AUTOREMOVE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 $BREW install $MISSING \
    && DONE+=("Homebrew 套件：${MISSING[*]}") || WARN+=("brew install ${MISSING[*]} 失敗，請手動處理")
else
  WARN+=("沒有安裝 ${MISSING[*]}：逐字稿精修、錄影後處理不能用。之後執行：brew install ${MISSING[*]}")
fi

# ---------- 3. 錄音程式 ----------
step "安裝錄音程式到 $CONFIG_DIR"
# 0.12 以前裝在 ~/.config/course-recorder：整個搬過來（設定、暫存、沒做完的精修都跟著走），
# 舊位置留一個指向新位置的捷徑，舊錄音的暫存紀錄裡寫的舊路徑照樣找得到
if [[ -d $OLD_CONFIG_DIR && ! -L $OLD_CONFIG_DIR && ! -e $CONFIG_DIR ]]; then
  mkdir -p "${CONFIG_DIR:h}"
  mv "$OLD_CONFIG_DIR" "$CONFIG_DIR" && ln -s "$CONFIG_DIR" "$OLD_CONFIG_DIR" \
    && DONE+=("舊位置 $OLD_CONFIG_DIR 已搬到 $CONFIG_DIR（舊位置留捷徑）")
  mkdir -p "$CONFIG_DIR/backup"
  [[ -e $CONFIG_DIR/course-recorder.swift ]] && mv "$CONFIG_DIR/course-recorder.swift" "$CONFIG_DIR/backup/course-recorder.swift.$STAMP"
elif [[ -d $OLD_CONFIG_DIR && ! -L $OLD_CONFIG_DIR ]]; then
  WARN+=("$OLD_CONFIG_DIR 和 $CONFIG_DIR 同時存在，舊的沒有搬。確認舊的沒有要補做的錄音後可以自己刪掉")
fi
mkdir -p "$CONFIG_DIR/bin" "$CONFIG_DIR/backup"
for f in meeting-recorder.swift ocr.swift Info.plist transcribe.py video_post.py; do
  [[ -e $CONFIG_DIR/$f ]] && cp -p "$CONFIG_DIR/$f" "$CONFIG_DIR/backup/$f.$STAMP"
  cp "$PKG/recorder/$f" "$CONFIG_DIR/$f"
done
# 在這台重新編譯：最低系統版本會對上這台，也不會有從別台複製執行檔被系統擋下的問題
BUILT=0
if (( OSMAJOR >= 26 )); then
  say "   編譯中（約 1 分鐘）…"
  if ( cd "$CONFIG_DIR" && swiftc -O -swift-version 5 -o bin/meeting-recorder.new meeting-recorder.swift \
         -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist 2>"$CONFIG_DIR/build.log" \
       && swiftc -O -swift-version 5 -o bin/ocr.new ocr.swift 2>>"$CONFIG_DIR/build.log" ); then
    mv "$CONFIG_DIR/bin/meeting-recorder.new" "$CONFIG_DIR/bin/meeting-recorder"; mv "$CONFIG_DIR/bin/ocr.new" "$CONFIG_DIR/bin/ocr"; BUILT=1
    # 舊名稱留捷徑：已經開著的 Obsidian、還沒更新的 0.12 外掛都找 bin/course-recorder
    # （舊的執行檔編好新版才換掉：編譯失敗時舊版還能用）
    [[ -f $CONFIG_DIR/bin/course-recorder && ! -L $CONFIG_DIR/bin/course-recorder ]] && mv "$CONFIG_DIR/bin/course-recorder" "$CONFIG_DIR/backup/course-recorder.bin.$STAMP"
    ln -sfn meeting-recorder "$CONFIG_DIR/bin/course-recorder"
  else
    rm -f "$CONFIG_DIR/bin/"*.new
    say "   編譯失敗（訊息在 $CONFIG_DIR/build.log）"
  fi
fi
if (( BUILT )) && "$CONFIG_DIR/bin/meeting-recorder" --selftest-limiter >/dev/null 2>&1; then
  DONE+=("錄音程式（本機編譯）")
else
  WARN+=("錄音程式沒有編譯成功或跑不起來（需要 macOS 26 以上與 Command Line Tools）。訊息在 $CONFIG_DIR/build.log")
fi
/usr/bin/python3 -I -m py_compile "$CONFIG_DIR/transcribe.py" "$CONFIG_DIR/video_post.py" 2>/dev/null \
  || WARN+=("/usr/bin/python3 無法執行精修腳本（需要 Command Line Tools 的 python3）")

# ---------- 4. whisper 模型 ----------
step "whisper 模型"
MODEL=ggml-large-v3-turbo.bin
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
if [[ -s $MODEL_DIR/$MODEL ]]; then
  say "   已經有了"
elif [[ ${ASSUME_YES:-0} != 1 ]] && ask "   沒有模型。要現在下載嗎？（1.6 GB，來源：whisper.cpp 在 Hugging Face 的官方模型庫）"; then
  mkdir -p "$MODEL_DIR"
  if curl -L --fail --progress-bar -o "$MODEL_DIR/$MODEL.part" "$MODEL_URL"; then
    mv "$MODEL_DIR/$MODEL.part" "$MODEL_DIR/$MODEL" && DONE+=("whisper 模型（1.6 GB）")
  else
    rm -f "$MODEL_DIR/$MODEL.part"; WARN+=("模型下載失敗。手動下載 $MODEL_URL 放到 $MODEL_DIR/")
  fi
else
  WARN+=("沒有 whisper 模型（沒有它，錄完後的逐字稿精修不能用）。下載 $MODEL_URL 放到 $MODEL_DIR/")
fi

# ---------- 5. Obsidian 外掛 ----------
step "Obsidian 外掛"
if [[ -z $VAULT_DIR || ! -d $VAULT_DIR/.obsidian ]]; then
  [[ -n $VAULT_DIR ]] && say "   找不到 vault：$VAULT_DIR"
  if [[ ${ASSUME_YES:-0} != 1 ]]; then
    read "VAULT_DIR?   請輸入 Obsidian vault 的資料夾路徑（裡面有 .obsidian；直接按 Enter 跳過）："
    VAULT_DIR=${~VAULT_DIR}
  fi
fi
if [[ -n $VAULT_DIR && -d $VAULT_DIR/.obsidian ]]; then
  PLUG="$VAULT_DIR/.obsidian/plugins/meeting-recorder"
  OLD_PLUG="$VAULT_DIR/.obsidian/plugins/course-recorder"   # 0.11.0 以前的外掛代號（2026-11-19 改名，準備上架 Obsidian 市集）
  mkdir -p "$VAULT_DIR/.obsidian/plugins"
  OLD_DATA=""
  if [[ -d $OLD_PLUG ]]; then
    mkdir -p "$CONFIG_DIR/backup"
    mv "$OLD_PLUG" "$CONFIG_DIR/backup/plugin-course-recorder.$STAMP" && DONE+=("舊版外掛 course-recorder 已移到 $CONFIG_DIR/backup/plugin-course-recorder.$STAMP")
    [[ -f $CONFIG_DIR/backup/plugin-course-recorder.$STAMP/data.json ]] && OLD_DATA="$CONFIG_DIR/backup/plugin-course-recorder.$STAMP/data.json"
  fi
  if [[ -d $PLUG ]]; then
    typeset -a OLD_FILES; OLD_FILES=("$PLUG"/*(N.))   # (N)：資料夾是空的也不報錯
    mkdir -p "$CONFIG_DIR/backup/plugin.$STAMP"
    (( ${#OLD_FILES} )) && cp -p $OLD_FILES "$CONFIG_DIR/backup/plugin.$STAMP/"
    [[ -f $PLUG/data.json ]] && cp -p "$PLUG/data.json" "$CONFIG_DIR/backup/plugin.$STAMP.data.json"
  fi
  mkdir -p "$PLUG" && cp "$PKG/obsidian-plugin/meeting-recorder/"{main.js,manifest.json,styles.css} "$PLUG/"
  if [[ -n $OLD_DATA && ! -f $PLUG/data.json ]]; then cp -p "$OLD_DATA" "$PLUG/data.json" && DONE+=("舊版外掛的設定已帶到新版"); fi
  # 加進啟用清單（用 JSON 解析，不用文字取代）
  /usr/bin/python3 -I - "$VAULT_DIR/.obsidian/community-plugins.json" <<'PY' && DONE+=("Obsidian 外掛 → $PLUG") || WARN+=("外掛檔案放好了，但沒能加進啟用清單：請到 Obsidian 設定 → 第三方外掛，打開「Meeting Recorder」")
import json, os, sys
p = sys.argv[1]
ids = json.load(open(p, encoding="utf-8")) if os.path.exists(p) else []
old = list(ids)
ids = ["meeting-recorder" if i == "course-recorder" else i for i in ids]   # 舊代號原地換掉
if "meeting-recorder" not in ids:
    ids.append("meeting-recorder")
ids = list(dict.fromkeys(ids))
if ids != old:
    json.dump(ids, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
else
  WARN+=("沒有安裝 Obsidian 外掛（找不到 vault）。手動做法：把這個 repo 的 obsidian-plugin/meeting-recorder 複製到 <vault>/.obsidian/plugins/，再到 Obsidian 設定啟用")
fi

# ---------- 6. 結果 ----------
print -r -- ""; print -r -- "════════ 結果 ════════"
for d in $DONE; do say "✔ $d"; done
for w in $WARN; do say "⚠ $w"; done
cat <<TXT

接下來要手動做的（系統不允許腳本代勞）：
1. 重新啟動 Obsidian；左側功能列會出現 🎤。第一次按錄音時依序允許 Obsidian：
   麥克風、系統錄音（螢幕與系統錄音）、語音辨識；要錄 App 畫面再允許螢幕錄製（允許後要重開 Obsidian）
2. 第一次用即時字幕，macOS 可能要下載中文語音辨識模型（需要網路，約幾百 MB）
3. 搭配 AnnotateScreen（選用，github.com/FengQing-TW/annotate-screen）時，截圖要自動收進筆記：
   第一次會問 Obsidian 能不能取用「下載」資料夾，請允許
說明文件：docs/使用說明.md
提醒：這個工具會錄下所有人的聲音。用在會議時，錄音前請先告知對方。
TXT
(( ${#WARN} == 0 ))
