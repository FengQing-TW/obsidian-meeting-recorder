// 錄音筆記（本機外掛）：左側按鈕＋命令，呼叫 ~/.config/course-recorder/bin/course-recorder
// 1. 錄「電腦播放的聲音＋麥克風」成 m4a，同時即時產生逐字稿寫進筆記（對方＝電腦聲音、我＝麥克風）
// 2. 錄音中貼進這篇筆記的截圖：搬進逐字稿、標上錄音時間，並用 bin/ocr 辨識圖中文字（放在圖下方、可摺疊）
// 3. 停止後插入錄音檔，再用 whisper（transcribe.py）精修逐字稿並取代即時版；截圖保留、截圖文字當作詞彙提示
// 4. 點逐字稿裡的時間（`12:34`）就從那裡播放錄音
// 6. 也可以同時錄某個 App 的畫面（macOS 內建選擇視窗）：影片存到「下載／螢幕錄影」，錄完合進聲音、
//    自動偵測投影片換頁並截圖（video_post.py），截圖放進逐字稿；點時間會用 QuickTime 跳到影片的那個畫面
// 7. AnnotateScreen（螢幕標註工具，github.com/FengQing-TW/annotate-screen）存到「下載」的截圖 AnnotateScreen_*.png 會自動搬進目前的筆記；
//    錄音中則放進逐字稿、對上錄音時間、辨識文字
// 5. 每場錄音的狀態存在 ~/.config/course-recorder/tmp/<id>/session.json；Obsidian 中途關閉或當掉，
//    下次啟動會自動把沒做完的（插入錄音檔、whisper 精修）補完
// 說明：README.md 與 docs/使用說明.md
const obsidian = require("obsidian");
const { Plugin, Notice, Menu, setIcon, MarkdownView, TFile, normalizePath, moment } = obsidian;
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".config/course-recorder");
const BIN = path.join(DIR, "bin/course-recorder");
const OCR = path.join(DIR, "bin/ocr");
const TRANSCRIBE = path.join(DIR, "transcribe.py");
const VIDEO_POST = path.join(DIR, "video_post.py");
// 介面語言（2026-11-19，準備上架 Obsidian 市集）：data.json 的 lang＝"zh"／"en"／"auto"（預設，跟著 Obsidian 的介面語言）。
// 在 onload 一開始決定，之後不變；寫進筆記的標題與說話者也跟著這個語言，解析時兩種都認。
let ZH = true;
const T = (zh, en) => (ZH ? zh : en);
const pickLang = (setting) => {
  if (setting === "zh" || setting === "en") return setting === "zh";
  // Obsidian 1.8 起有 getLanguage()；舊版退回 moment 的語系（Obsidian 會把它設成介面語言）。只用官方 API（市集審查建議）
  let ui = "";
  try { ui = typeof obsidian.getLanguage === "function" ? obsidian.getLanguage() : ""; } catch (_) { /* 取不到就看 moment */ }
  return (ui || moment.locale() || "en").toLowerCase().startsWith("zh");
};
let VIDEO_DIR = path.join(os.homedir(), "Downloads/螢幕錄影");   // 錄影檔：使用者過一陣子會自己刪（英文介面是 Downloads/Screen Recordings）
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const ANNOTATE_RE = /^AnnotateScreen_\d{8}_\d{6}(?:_\d+)?\.png$/;   // AnnotateScreen 的存檔檔名
const VIDEO_RE = /🎬 \[[^\]]*\]\((file:\/\/[^)]+)\)(?:\s*%%video-offset (-?[\d.]+)%%)?/;
const TMP = path.join(DIR, "tmp");
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff"];
let HEADING = "### 🎙️ 錄音 ";
const HEADINGS = ["### 🎙️ 錄音 ", "### 🎙️ Recording "];
const isHeading = (l) => HEADINGS.some((x) => l.startsWith(x));
const WHO_EN = { "對方": "Them", "我": "Me" };
const TIME_RE = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
const ITEM_RE = /^- `((?:\d{1,2}:)?\d{1,2}:\d{2})` /;                               // 帶時間的一行
const OWN_RE = /^- `(?:\d{1,2}:)?\d{1,2}:\d{2}` (?:\*\*(?:對方|我|Them|Me)\*\*(?:：|: )|📷 |🖼️ )/;     // 外掛自己產生的一行
const MARK_START_RE = /%%course-rec \d+ start%%/, MARK_END_RE = /%%course-rec \d+ end%%/;
// 引用區塊（截圖／投影片的辨識文字）裡的行不算標記。2026-11-17 實際發生：錄影選到 Obsidian 自己的視窗，
// 文字辨識把畫面上的「%%course-rec … end%%」原樣認出來 103 次；截圖在錄音中途進筆記的話，結束標記會被認錯
const isQuote = (l) => /^\s*>/.test(l);
// 辨識出來的文字不能有「%%」：除了上面的標記問題，落單的 %% 在 Obsidian 會把後面的內容全部變成註解
const cleanOcr = (t) => t.trim().replace(/%(?=%)/g, "% ");
const RECORDING_RE = /!\[\[([^\]|]*Recording \d{14}\.m4a)[^\]]*\]\]|!\[[^\]]*\]\(([^)]*Recording(?:%20| )\d{14}\.m4a)\)/;

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
};
const parseTime = (t) => t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
const segLine = (seg) => `- \`${fmtTime(seg.start)}\` **${ZH ? seg.who : (WHO_EN[seg.who] || seg.who)}**${T("：", ": ")}${seg.text}`;
const imageLines = (img) => {
  const slide = img.kind === "slide";
  const out = [`- \`${fmtTime(img.start)}\` ${slide ? "🖼️" : "📷"} ${img.link}`];
  if (img.ocr && img.ocr.trim()) {
    out.push(`  > [!quote]- ${slide ? T("投影片文字", "Slide text") : T("截圖文字", "Screenshot text")}`);
    for (const l of img.ocr.trim().split("\n")) out.push(`  > ${l}`);
  }
  return out.join("\n");
};
const fileNames = (name) => [...new Set([name, encodeURI(name), name.replace(/ /g, "%20")])];
// 文字辨識一次最多跑 3 個：連續貼圖或一次處理幾百張投影片時，不要同時啟動一大堆程序
let ocrRunning = 0;
const ocrWaiting = [];
const runOcr = (file) => new Promise((resolve) => {
  const go = () => {
    ocrRunning++;
    execFile(OCR, [file], { timeout: 30000 }, (err, out) => {
      ocrRunning--;
      ocrWaiting.shift()?.();
      resolve(err ? "" : cleanOcr(out));
    });
  };
  if (ocrRunning < 3) go(); else ocrWaiting.push(go);
});
// 這個 pid 還活著、而且真的是我們的程式（pid 會被系統重複使用，所以要看指令內容）
// 正在處理中的錄音 id。放在 globalThis：外掛被重新載入時，舊的實例還在收尾，新的實例不要重複做同一場
const inFlight = (globalThis.__courseRecorderInFlight = globalThis.__courseRecorderInFlight || new Set());
const alive = (pid, needle) => {
  if (!pid) return false;
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes(needle);
  } catch (_) { return false; }
};

module.exports = class CourseRecorder extends Plugin {
  onload() {
    let langSetting = "auto";
    try {
      const f = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, "data.json");
      langSetting = (JSON.parse(fs.readFileSync(f, "utf8")) || {}).lang || "auto";
    } catch (_) { /* 第一次安裝還沒有 data.json */ }
    ZH = pickLang(langSetting);
    HEADING = ZH ? HEADINGS[0] : HEADINGS[1];
    VIDEO_DIR = path.join(os.homedir(), ZH ? "Downloads/螢幕錄影" : "Downloads/Screen Recordings");
    this.proc = null;
    this.recording = null;
    this.busy = false;
    this.player = null;
    this.refineChain = Promise.resolve();   // whisper 一次只跑一個（模型吃 1.6 GB 以上）
    this.ribbon = this.addRibbonIcon("mic", T("錄音筆記：開始", "Meeting Recorder: start"), (evt) => this.toggle(evt));
    // 狀態列：錄音中顯示經過時間，點一下停止（左側按鈕只有顏色，看不出錄了多久、還有沒有在錄）
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("course-rec-status");
    this.statusEl.setAttribute("aria-label", T("點一下停止錄音", "Click to stop recording"));
    this.registerDomEvent(this.statusEl, "click", () => { if (this.proc) this.stop(); });
    this.registerInterval(window.setInterval(() => this.refreshStatus(), 1000));
    this.addCommand({ id: "start", name: T("開始錄音（電腦聲音＋麥克風＋即時逐字稿）", "Start recording (system audio + microphone + live transcript)"), callback: () => this.start(false) });
    this.addCommand({ id: "start-video", name: T("開始錄音＋錄 App 畫面", "Start recording + record an app window"), callback: () => this.start(true) });
    this.addCommand({ id: "stop", name: T("停止錄音並插入筆記", "Stop recording and insert into note"), callback: () => this.stop() });
    this.addCommand({ id: "stop-playback", name: T("停止播放錄音", "Stop playback"), callback: () => this.player?.pause() });
    this.addCommand({ id: "recover", name: T("補做沒完成的逐字稿精修", "Finish incomplete transcript refinement"), callback: () => this.recoverOrphans(true) });
    this.registerEvent(this.app.vault.on("create", (f) => this.onFileCreated(f)));
    this.registerEvent(this.app.vault.on("rename", (f) => {
      if (this.recording?.noteFile === f) this.saveSession(this.recording);   // 筆記改名或搬家：記下新路徑
    }));
    // 點逐字稿的時間 → 播放錄音。用 mousedown 捕獲階段，搶在編輯器把游標移進去之前
    this.registerDomEvent(document, "mousedown", (ev) => this.onTimeClick(ev), { capture: true });
    // 閱讀模式：時間加上可點的樣式
    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll("li").forEach((li) => {
        const c = li.querySelector("code");
        const t = c?.textContent.trim();
        if (c && TIME_RE.test(t) && li.textContent.trim().startsWith(t)) c.addClass("course-rec-time");
      });
    });
    this.app.workspace.onLayoutReady(() => this.recoverOrphans(false));
    // AnnotateScreen 截圖自動收進筆記（可用命令暫停；設定存在外掛的 data.json）
    this.importing = new Set();
    this.addCommand({ id: "toggle-annotate-import", name: T("開啟／暫停自動收 AnnotateScreen 截圖", "Toggle auto-import of AnnotateScreen screenshots"), callback: () => this.toggleAnnotateImport() });
    this.loadData().then((d) => {
      this.settings = Object.assign({ annotateImport: true }, d || {});
      if (this.settings.annotateImport) this.startAnnotateWatch();
    });
    this.refresh();
  }

  onunload() {
    this.stopAnnotateWatch();
    // 讓錄音程式收尾存檔；逐字稿精修留給下次啟動時的 recoverOrphans
    if (this.proc) this.proc.kill("SIGINT");
    this.player?.pause();
  }

  refresh() {
    const r = !!this.proc;
    setIcon(this.ribbon, r ? "square" : "mic");
    this.ribbon.setAttribute("aria-label", r ? T("錄音筆記：停止", "Meeting Recorder: stop") : T("錄音筆記：開始", "Meeting Recorder: start"));
    this.ribbon.toggleClass("course-rec-active", r);
    this.refreshStatus();
  }

  refreshStatus() {
    if (!this.statusEl) return;
    const rec = this.recording;
    if (!this.proc || !rec) { this.statusEl.setText(""); this.statusEl.hide(); return; }
    this.statusEl.show();
    let text;
    if (rec.stopping) text = T("■ 存檔中…", "■ Saving…");
    else if (!rec.audioAt) text = T("● 準備中…", "● Preparing…");
    else text = `${T("● 錄音", "● REC")} ${fmtTime((Date.now() - rec.audioAt) / 1000 - rec.gap)}${rec.video?.saved === false && rec.video?.offset != null ? T("＋錄影", " + video") : ""}${rec.stalled ? T("（收音中斷）", " (audio interrupted)") : ""}`;
    this.statusEl.setText(text);
  }

  // 錄音中：按了就停止。沒在錄：跳出選單，選只錄音或連畫面一起錄
  toggle(evt) {
    if (this.proc) return this.stop();
    if (!evt) return this.start(false);
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(T("只錄音", "Audio only")).setIcon("mic").onClick(() => this.start(false)));
    menu.addItem((i) => i.setTitle(T("錄音＋錄 App 畫面…", "Audio + app window…")).setIcon("monitor").onClick(() => this.start(true)));
    menu.showAtMouseEvent(evt);
  }

  // ---------- 每場錄音的狀態存檔（給中途關閉後的復原用） ----------
  saveSession(rec, extra = {}) {
    Object.assign(rec, extra);
    try {
      if (!fs.existsSync(rec.tmpdir)) return;
      const data = {
        id: rec.id, note: rec.noteFile?.path ?? null, rel: rec.rel, label: rec.label, state: rec.state,
        pid: rec.pid ?? null, refinePid: rec.refinePid ?? null, recovered: !!rec.recovered,
        images: rec.images.map((i) => ({ start: i.start, link: i.link, ocr: i.ocr, names: i.names })),
        video: rec.video ? { path: rec.video.path, offset: rec.video.offset, saved: !!rec.video.saved } : null,
        slides: (rec.slides || []).map((i) => ({ kind: "slide", start: i.start, link: i.link, ocr: i.ocr, names: i.names })),
        slidesDone: !!rec.slidesDone,
      };
      fs.writeFileSync(path.join(rec.tmpdir, "session.json"), JSON.stringify(data, null, 1));
    } catch (e) { console.error("course-recorder saveSession", e); }
  }

  // ---------- 改筆記 ----------
  findView(file) {
    let view = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!view && leaf.view instanceof MarkdownView && leaf.view.file === file) view = leaf.view;
    });
    return view;
  }

  // 開著就用編輯器（只換有變動的那一段，不影響游標），沒開就直接改檔
  async editNote(file, fn) {
    const view = this.findView(file);
    if (view && view.getMode() === "source") {
      const ed = view.editor, old = ed.getValue(), nw = fn(old);
      if (nw === old) return;
      let a = 0;
      while (a < old.length && a < nw.length && old[a] === nw[a]) a++;
      let b = 0;
      while (b < old.length - a && b < nw.length - a && old[old.length - 1 - b] === nw[nw.length - 1 - b]) b++;
      ed.replaceRange(nw.slice(a, nw.length - b), ed.offsetToPos(a), ed.offsetToPos(old.length - b));
      return;
    }
    await this.app.vault.process(file, fn);
  }

  // 筆記被刪掉了：另開一篇接著寫，逐字稿不能因此不見
  async ensureNote(rec) {
    if (rec.noteFile && this.app.vault.getAbstractFileByPath(rec.noteFile.path) === rec.noteFile) return;
    const { start, end } = this.markers(rec.id);
    const folder = this.app.fileManager.getNewFileParent("");
    const base = `${T("錄音", "Recording")} ${rec.label.replace(":", "")}`;
    let p = normalizePath(`${folder.path}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder.path}/${base} (${i}).md`);
    rec.noteFile = await this.app.vault.create(p, `${HEADING}${rec.label}\n${start}\n${end}\n`);
    this.saveSession(rec);
    new Notice(T(`錄音筆記：原本的筆記找不到了，逐字稿改寫到「${rec.noteFile.basename}」`, `Meeting Recorder: the original note is gone; the transcript now goes to "${rec.noteFile.basename}"`), 15000);
  }

  // 所有改筆記的動作排隊執行，避免互相覆蓋；單一動作失敗不影響後面的
  // 回傳的 Promise 解析成 true（有寫成功）或 false（失敗）；要確定寫進去才能做下一步的地方要看這個值
  enqueue(rec, fn) {
    rec.queue = rec.queue
      .then(() => this.ensureNote(rec))
      .then(() => this.editNote(rec.noteFile, fn))
      .then(() => true)
      .catch((e) => { console.error("course-recorder edit", e); rec.lastEditError = String(e); return false; });
    return rec.queue;
  }

  markers(id) {
    return { start: `%%course-rec ${id} start%%`, end: `%%course-rec ${id} end%%` };
  }

  // 找出這場錄音在筆記裡的位置：s／e 是開始、結束標記的行號，h 是標題的行號（找不到是 -1）
  locate(lines, rec) {
    const { start, end } = this.markers(rec.id);
    const s = lines.findIndex((l) => l.includes(start) && !isQuote(l));
    const e = s < 0 ? -1 : lines.findIndex((l, i) => i > s && l.includes(end) && !isQuote(l));
    let h = -1;
    for (let i = s - 1; s >= 0 && i >= Math.max(0, s - 3) && h < 0; i--) if (isHeading(lines[i])) h = i;
    return { s, e, h };
  }

  // 依時間插進逐字稿：放在第一個「時間比它晚」的項目前面（即時辨識會晚 10～20 秒才出字，截圖可能比前面的話先到）
  insertInto(lines, rec, sec, text) {
    const { s, e } = this.locate(lines, rec);
    if (s < 0 || e < 0) return false;
    let at = e;
    for (let i = s + 1; i < e; i++) {
      const m = lines[i].match(ITEM_RE);
      if (m && parseTime(m[1]) > sec) { at = i; break; }
    }
    lines.splice(at, 0, ...text.split("\n"));
    return true;
  }

  insertSorted(rec, sec, text) {
    return this.enqueue(rec, (t) => {
      const lines = t.split("\n");
      return this.insertInto(lines, rec, sec, text) ? lines.join("\n") : t;
    });
  }

  // 改標題後面的狀態文字；extras（錄音檔、錄影連結）有給的話，依序插在標題下面，已經有的不重複插
  setHeading(rec, suffix, extras = []) {
    return this.enqueue(rec, (t) => {
      const lines = t.split("\n");
      let { s, h } = this.locate(lines, rec);
      if (h >= 0) lines[h] = `${HEADING}${rec.label}${suffix}`;
      const missing = extras.filter((x) => x && !t.includes(x));
      if (missing.length) {
        if (h < 0 && s < 0) { lines.push("", `${HEADING}${rec.label}`); h = lines.length - 1; }
        let at = h >= 0 ? h + 1 : s;
        while (h >= 0 && at < lines.length && extras.some((x) => x && lines[at] === x)) at++;   // 接在已經有的後面
        lines.splice(at, 0, ...missing);
      }
      return lines.join("\n");
    });
  }

  // ---------- 開始 ----------
  // 逐字稿要寫進哪一篇：目前的筆記 → 最近用過的筆記分頁（例如焦點在終端機時）→ 新建一篇
  async pickNote() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active.file;
    let best = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file && (!best || (leaf.activeTime || 0) > (best.activeTime || 0))) best = leaf;
    });
    if (best) return best.view.file;
    const folder = this.app.fileManager.getNewFileParent("");
    const note = await this.app.vault.create(normalizePath(`${folder.path}/${T("錄音", "Recording")} ${moment().format("YYYY-MM-DD HHmm")}.md`), "");
    await this.app.workspace.getLeaf(false).openFile(note);
    return note;
  }

  async insertBlock(rec) {
    const { start, end } = this.markers(rec.id);
    const head = `${HEADING}${rec.label}${T(`（錄音中${rec.live ? "，逐字稿即時更新" : ""}）`, ` (recording${rec.live ? ", live transcript" : ""})`)}`;
    const view = this.findView(rec.noteFile);
    if (!(view && view.getMode() === "source")) {
      await this.editNote(rec.noteFile, (t) => `${t.replace(/\n*$/, "")}\n\n${head}\n${start}\n${end}\n`);
      return;
    }
    const ed = view.editor, lines = ed.getValue().split("\n"), cursorLine = ed.getCursor().line;
    let line = Math.min(cursorLine, lines.length - 1);
    // 游標在 frontmatter 裡 → 插在 frontmatter 後面
    if (lines[0] === "---") {
      const fmEnd = lines.indexOf("---", 1);
      if (fmEnd > 0 && line <= fmEnd) line = fmEnd;
    }
    // 游標在另一場錄音的逐字稿區塊裡 → 插在那個區塊後面
    let open = false;
    for (let i = 0; i <= line; i++) {
      if (isQuote(lines[i])) continue;
      if (MARK_START_RE.test(lines[i])) open = true;
      if (MARK_END_RE.test(lines[i])) open = false;
    }
    if (open) {
      const close = lines.findIndex((l, i) => i >= line && MARK_END_RE.test(l) && !isQuote(l));
      if (close >= 0) line = close;
    }
    const cur = lines[line];
    let first;
    if (cur.trim() === "" && line === cursorLine) {
      // 上一行有字的話先空一行，標題才不會黏在文字下面
      const gap = line > 0 && lines[line - 1].trim() !== "" ? "\n" : "";
      ed.replaceRange(`${gap}${head}\n${start}\n${end}\n`, { line, ch: 0 }, { line, ch: cur.length });
      first = line + (gap ? 1 : 0);
    } else {
      // 不把游標所在的那一行切成兩半：接在那一行後面
      ed.replaceRange(`\n\n${head}\n${start}\n${end}\n`, { line, ch: cur.length });
      first = line + 2;
    }
    ed.setCursor({ line: first + 3, ch: 0 });   // 游標放到區塊下面，接著打字或貼圖都在逐字稿外面
  }

  async start(withVideo = false) {
    if (this.proc || this.busy) return;
    this.busy = true;
    try {
      if (!fs.existsSync(BIN)) {
        new Notice(T(`錄音筆記：找不到錄音程式 ${BIN}`, `Meeting Recorder: recorder not found at ${BIN}. Run install.sh first.`), 15000);
        return;
      }
      const note = await this.pickNote();
      const id = moment().format("YYYYMMDDHHmmss");
      const rel = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(`Recording ${id}.m4a`, note.path));
      const dir = path.posix.dirname(rel);
      if (dir !== "." && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
      const abs = path.join(this.app.vault.adapter.getBasePath(), rel);
      const tmpdir = path.join(TMP, id);
      const args = [abs, "--transcribe", tmpdir];
      let video = null;
      if (withVideo) {
        const safe = note.basename.replace(/[\\/:*?"<>|#^[\]]/g, "_").slice(0, 60);
        video = { path: path.join(VIDEO_DIR, `${safe} ${moment().format("YYYY-MM-DD HHmm")}.mp4`), offset: null, saved: false };
        args.push("--video", video.path);
      }

      const proc = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", pending = "";
      const rec = { id, rel, tmpdir, noteFile: note, label: moment().format("YYYY-MM-DD HH:mm"), state: "recording",
                    pid: proc.pid, queue: Promise.resolve(), live: false, audioAt: null, gap: 0, images: [], ocrJobs: [],
                    saved: false, empty: false, video, slides: [], err: () => stderr };
      proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-8000); });

      const started = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 20000);
        proc.stdout.on("data", (d) => {
          pending += d;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const l of lines) {
            try { this.onLine(rec, l, resolve, timer); } catch (e) { console.error("course-recorder onLine", e); }
          }
        });
        proc.on("error", (e) => { stderr += String(e); clearTimeout(timer); resolve(false); });
        proc.on("exit", () => { clearTimeout(timer); resolve(false); });
      });
      if (!started) {
        proc.kill("SIGINT");
        new Notice(T(`錄音筆記：沒有開始錄音\n${stderr.trim()}`, `Meeting Recorder: recording did not start\n${stderr.trim()}`), 15000);
        return;
      }
      this.proc = proc;
      this.recording = rec;
      inFlight.add(rec.id);
      proc.on("exit", (code) => this.finished(rec, code).catch((e) => console.error("course-recorder finished", e)));
      this.saveSession(rec);
      await this.insertBlock(rec);

      const where = this.app.workspace.getActiveFile() === note ? "" : T(`逐字稿寫進「${note.basename}」。`, ` Transcript goes to "${note.basename}".`);
      rec.waiting = new Notice(T(`錄音筆記：準備中…${where}（AirPods 切換到通話模式，最多約 10 秒）`, `Meeting Recorder: preparing…${where} (switching the headset to call mode can take up to about 10 seconds)`), 0);
      if (rec.audioAt) rec.waiting.hide();
    } catch (e) {
      console.error("course-recorder start", e);
      new Notice(T(`錄音筆記：開始失敗 ${e}`, `Meeting Recorder: failed to start ${e}`), 15000);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  // 錄音程式的 stdout 協定，一行一個事件（完整列表在 course-recorder.swift 開頭）
  onLine(rec, l, resolveStarted, timer) {
    if (l.startsWith("STARTED")) {
      rec.live = l.includes("LIVE");
      clearTimeout(timer);
      resolveStarted(true);
    } else if (l === "AUDIO") {
      rec.audioAt = Date.now();   // 錄音檔的第 0 秒
      rec.waiting?.hide();
      new Notice(T(`● 錄音筆記：開始收音${rec.live ? "（逐字稿約晚 10～20 秒出現）" : ""}`, `● Meeting Recorder: recording${rec.live ? " (the transcript appears 10–20 seconds behind)" : ""}`));
    } else if (l.startsWith("SEG\t")) {
      const [, who, s, e, ...rest] = l.split("\t");
      const start = parseFloat(s);
      this.insertSorted(rec, start, segLine({ who, start, end: parseFloat(e), text: rest.join(" ") }));
    } else if (l.startsWith("SAVED")) {
      rec.saved = true;
    } else if (l === "EMPTY") {
      rec.empty = true;
    } else if (l === "STALLED") {
      rec.stalled = true;
      rec.stallNotice = new Notice(T("⚠️ 錄音筆記：收音中斷了（耳機斷線或音訊裝置被換掉？）\n已經錄到的部分不受影響。裝置接回來會自動繼續；也可以按停止存檔後重新開始。", "⚠️ Meeting Recorder: audio input stopped (headset disconnected or audio device changed?)\nWhat was recorded so far is safe. Recording resumes when the device is back, or press stop to save and start again."), 0);
    } else if (l.startsWith("RESUMED")) {
      rec.gap = parseFloat(l.slice(8)) || rec.gap;   // 累計中斷秒數：錄音檔的時間軸比牆上時鐘短這麼多
      rec.stalled = false;
      rec.stallNotice?.hide();
      new Notice(T(`錄音筆記：收音恢復了（中間約 ${Math.round(rec.gap)} 秒沒有錄到）`, `Meeting Recorder: audio is back (about ${Math.round(rec.gap)} seconds were not recorded)`), 8000);
    } else if (l.startsWith("EXCLUDED_PLAYING ")) {
      new Notice(T(`⚠️ ${l.slice(17)} 正在播放，但設定為不錄它的聲音。`, `⚠️ ${l.slice(17)} is playing, but it is excluded from recording in your settings.`), 15000);
    } else if (l.startsWith("LIVE_FAILED")) {
      new Notice(T(`⚠️ 即時逐字稿無法啟動，只錄音；停止後仍會用 whisper 產生逐字稿。\n${l.slice(12)}`, `⚠️ Live transcript could not start; recording audio only. whisper will still produce a transcript after you stop.\n${l.slice(12)}`), 15000);
    } else if (l.startsWith("LIVE_STOPPED")) {
      new Notice(T(`⚠️ 「${l.slice(13)}」的即時逐字稿中斷了。錄音不受影響，停止後 whisper 會補上完整逐字稿。`, `⚠️ Live transcript for "${WHO_EN[l.slice(13)] || l.slice(13)}" stopped. Recording is not affected; whisper will produce the full transcript after you stop.`), 15000);
    } else if (l === "VIDEO_PICKING") {
      rec.pickNotice = new Notice(T("🎬 請在跳出的視窗選擇要錄的 App 或視窗（錄音已經開始了）", "🎬 Choose the app or window to record in the system picker (audio recording has already started)"), 0);
    } else if (l.startsWith("VIDEO_STARTED")) {
      rec.pickNotice?.hide();
      new Notice(T(`● 錄影開始：存到「下載／螢幕錄影」\n${path.basename(rec.video?.path || "")}`, `● Video recording started: saving to Downloads/Screen Recordings\n${path.basename(rec.video?.path || "")}`), 8000);
    } else if (l.startsWith("VIDEO_OFFSET ")) {
      if (rec.video) { rec.video.offset = parseFloat(l.slice(13)); this.saveSession(rec); }
    } else if (l.startsWith("VIDEO_SAVED")) {
      if (rec.video) { rec.video.saved = true; this.saveSession(rec); }
    } else if (l === "VIDEO_CANCELLED") {
      rec.pickNotice?.hide();
      rec.video = null;
      this.saveSession(rec);
      new Notice(T("錄音筆記：沒有選 App，這次只錄音", "Meeting Recorder: no app selected; recording audio only"), 8000);
    } else if (l.startsWith("VIDEO_FAILED")) {
      rec.pickNotice?.hide();
      new Notice(T(`⚠️ 錄影失敗，錄音不受影響：${l.slice(13)}\n第一次使用要到「系統設定 → 隱私權與安全性 → 螢幕與系統錄音」允許 Obsidian`, `⚠️ Video recording failed; audio is not affected: ${l.slice(13)}\nOn first use, allow Obsidian in System Settings → Privacy & Security → Screen & System Audio Recording`), 20000);
    } else if (l.startsWith("VIDEO_STOPPED")) {
      new Notice(T(`⚠️ 錄影中斷了（被錄的 App 結束了？），錄音不受影響：${l.slice(14)}`, `⚠️ Video recording stopped (did the recorded app quit?); audio is not affected: ${l.slice(14)}`), 15000);
    } else if (l.startsWith("WARN ")) {
      new Notice(`⚠️ ${T("錄音筆記：", "Meeting Recorder: ")}${l.slice(5)}`, 20000);
    }
  }

  // ---------- 錄音中貼的截圖：搬進逐字稿、標時間、辨識文字 ----------
  onFileCreated(f) {
    const rec = this.recording;
    if (!rec || !rec.audioAt || !(f instanceof TFile) || !IMAGE_EXT.includes(f.extension.toLowerCase())) return;
    if (this.importing?.has(f.path)) return;   // AnnotateScreen 匯入的圖自己處理
    const sec = Math.max(0, (Date.now() - rec.audioAt) / 1000 - rec.gap);
    setTimeout(() => this.anchorImage(rec, f, sec, 0), 500);   // 等編輯器把連結貼進筆記
  }

  async noteText(file) {
    const view = this.findView(file);
    // 剛貼上的內容要一兩秒後才會存到磁碟，所以開著就讀編輯器
    if (view && view.getMode() === "source") return view.editor.getValue();
    return this.app.vault.cachedRead(file).catch(() => "");
  }

  async anchorImage(rec, f, sec, tries) {
    if (rec.state !== "recording") return;
    const names = fileNames(f.name);
    const text = await this.noteText(rec.noteFile);
    if (!names.some((n) => text.includes(n))) {
      // 不是貼在這篇筆記的圖就不管；連結可能還沒寫進去，最多再等 3 秒
      if (tries < 6) setTimeout(() => this.anchorImage(rec, f, sec, tries + 1), 500);
      return;
    }
    const img = { start: sec, link: "!" + this.app.fileManager.generateMarkdownLink(f, rec.noteFile.path), ocr: "", names };
    // 一次改完：先確認逐字稿區塊還在，再把「只有這張圖」的那一行清空（保留空行，游標才不會跑掉），圖放進逐字稿
    let anchored = false;
    await this.enqueue(rec, (t) => {
      const lines = t.split("\n");
      const { s, e } = this.locate(lines, rec);
      if (s < 0 || e < 0) return t;   // 標記被刪了：圖留在使用者貼的地方
      for (let i = 0; i < lines.length; i++) {
        if (i > s && i < e) continue;
        const trimmed = lines[i].trim();
        if (/^!\[\[[^\]]+\]\]$|^!\[[^\]]*\]\([^)]+\)$/.test(trimmed) && names.some((n) => trimmed.includes(n))) {
          lines[i] = "";
          break;
        }
      }
      anchored = this.insertInto(lines, rec, sec, imageLines(img));
      return anchored ? lines.join("\n") : t;
    });
    if (!anchored) return;
    this.afterAnchored(rec, img, f);
  }

  // 圖已經放進逐字稿：記下來、辨識圖中文字（本機 Vision），放在圖下方、並當作 whisper 的詞彙提示
  afterAnchored(rec, img, f) {
    rec.images.push(img);
    this.saveSession(rec);
    const absImg = path.join(this.app.vault.adapter.getBasePath(), f.path);
    const job = runOcr(absImg).then((ocr) => {
      if (!ocr) return;
      const before = imageLines(img);
      img.ocr = ocr;
      this.saveSession(rec);
      return this.enqueue(rec, (t) => t.replace(before, () => imageLines(img)));
    });
    rec.ocrJobs.push(job);
  }

  // ---------- AnnotateScreen 截圖 → 目前的筆記 ----------
  startAnnotateWatch() {
    if (this.annotateWatcher) return;
    try {
      this.annotateSeen = new Set(fs.readdirSync(DOWNLOADS).filter((n) => ANNOTATE_RE.test(n)));   // 啟動前就有的不管
      this.annotateWatcher = fs.watch(DOWNLOADS, (_type, name) => {
        if (name && ANNOTATE_RE.test(name) && !this.annotateSeen.has(name)) {
          this.annotateSeen.add(name);
          this.tryImportAnnotate(name, 1);
        }
      });
    } catch (e) {
      console.error("course-recorder watch Downloads", e);
      new Notice(T(`沒辦法監看「下載」資料夾，AnnotateScreen 截圖不會自動收進筆記：${e}\n（第一次要允許 Obsidian 取用「下載」）`, `Cannot watch the Downloads folder, so AnnotateScreen screenshots will not be imported: ${e}\n(Allow Obsidian to access Downloads on first use)`), 15000);
    }
  }

  // 失敗（多半是檔案還沒寫完）隔 5 秒再試一次；兩次都不行才放棄，原檔留在「下載」
  tryImportAnnotate(name, attempt) {
    this.importAnnotate(name).catch((e) => {
      console.error("course-recorder annotate import", e);
      if (attempt < 2 && fs.existsSync(path.join(DOWNLOADS, name))) {
        setTimeout(() => { if (this.annotateWatcher) this.tryImportAnnotate(name, attempt + 1); }, 5000);
      } else {
        const where = fs.existsSync(path.join(DOWNLOADS, name)) ? T("原檔留在「下載」", "the file is still in Downloads") : T("圖已在 vault 的附件資料夾，但沒有插進筆記", "the image is in the vault attachment folder but was not inserted");
        new Notice(T(`AnnotateScreen 截圖沒有收進筆記（${where}）：${name}\n${e}`, `AnnotateScreen screenshot was not imported (${where}): ${name}\n${e}`), 12000);
      }
    });
  }

  stopAnnotateWatch() {
    this.annotateWatcher?.close();
    this.annotateWatcher = null;
  }

  async toggleAnnotateImport() {
    this.settings.annotateImport = !this.settings.annotateImport;
    await this.saveData(this.settings);
    if (this.settings.annotateImport) this.startAnnotateWatch(); else this.stopAnnotateWatch();
    new Notice(T(`AnnotateScreen 截圖自動收進筆記：${this.settings.annotateImport ? "開啟" : "暫停"}`, `AnnotateScreen auto-import: ${this.settings.annotateImport ? "on" : "paused"}`));
  }

  // 等檔案寫完：大小連續兩次一樣才算好（最多等 5 秒）
  async waitStable(file) {
    let last = -1;
    for (let i = 0; i < 25; i++) {
      let size = -1;
      try { size = fs.statSync(file).size; } catch (_) { size = -1; }
      if (size > 0 && size === last) return true;
      last = size;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  // 收進哪一篇：錄音中 → 錄音那篇；否則目前的筆記 → 最近用過的筆記分頁；都沒有就留在「下載」
  annotateTarget() {
    if (this.recording?.noteFile) return this.recording.noteFile;
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active.file;
    let best = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file && (!best || (leaf.activeTime || 0) > (best.activeTime || 0))) best = leaf;
    });
    return best?.view.file ?? null;
  }

  async importAnnotate(name) {
    const src = path.join(DOWNLOADS, name);
    if (!(await this.waitStable(src))) throw new Error(T("檔案一直沒寫完", "the file never finished writing"));
    const takenAt = fs.statSync(src).birthtimeMs || Date.now();   // 截圖當下的時間，不是匯入的時間
    const note = this.annotateTarget();
    if (!note) { new Notice(T(`沒有打開的筆記，AnnotateScreen 截圖留在「下載」：${name}`, `No note is open; the AnnotateScreen screenshot stays in Downloads: ${name}`), 8000); return; }
    const dest = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(name, note.path));
    const dir = path.posix.dirname(dest);
    if (dir !== "." && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.createFolder(dir);
    this.importing.add(dest);
    let f;
    try {
      f = await this.app.vault.createBinary(dest, fs.readFileSync(src));
    } finally {
      setTimeout(() => this.importing.delete(dest), 5000);
    }
    const link = "!" + this.app.fileManager.generateMarkdownLink(f, note.path);
    // 確定插進筆記之後才刪「下載」那份（使用者 11-13 選：搬進 vault、下載不留）；中途失敗的話原檔還在
    const removeSource = () => { try { fs.unlinkSync(src); } catch (_) { /* 已經不在就算了 */ } };

    // 錄音中、而且是錄音那篇：直接放進逐字稿，時間＝截圖當下
    const rec = this.recording;
    if (rec && rec.noteFile === note && rec.audioAt && rec.state === "recording") {
      const sec = Math.max(0, (takenAt - rec.audioAt) / 1000 - rec.gap);
      const img = { start: sec, link, ocr: "", names: fileNames(f.name) };
      let anchored = false;
      await this.enqueue(rec, (t) => {
        const lines = t.split("\n");
        anchored = this.insertInto(lines, rec, sec, imageLines(img));
        return anchored ? lines.join("\n") : t;
      });
      if (anchored) {
        removeSource();
        this.afterAnchored(rec, img, f);
        new Notice(T(`📷 AnnotateScreen 截圖已放進逐字稿 ${fmtTime(sec)}`, `📷 AnnotateScreen screenshot added to the transcript at ${fmtTime(sec)}`), 4000);
        return;
      }
    }
    // 其他情況：插在游標所在行的下一行；筆記沒開著就加在文末
    const view = this.findView(note);
    if (view && view.getMode() === "source") {
      const ed = view.editor, line = ed.getCursor().line, cur = ed.getLine(line);
      if (cur.trim() === "") ed.replaceRange(link, { line, ch: 0 }, { line, ch: cur.length });
      else ed.replaceRange(`\n${link}`, { line, ch: cur.length });
      ed.setCursor({ line: cur.trim() === "" ? line + 1 : line + 2, ch: 0 });
      if (ed.lineCount() <= ed.getCursor().line) ed.replaceRange("\n", { line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length });
    } else {
      await this.app.vault.process(note, (t) => `${t.replace(/\n*$/, "")}\n\n${link}\n`);
    }
    removeSource();
    new Notice(T(`📷 AnnotateScreen 截圖已放進「${note.basename}」`, `📷 AnnotateScreen screenshot added to "${note.basename}"`), 4000);
  }

  // ---------- 停止 ----------
  stop() {
    const rec = this.recording;
    if (!this.proc || !rec || rec.stopping) return;
    rec.stopping = true;
    new Notice(T("錄音筆記：存檔中…（等最後一段逐字稿，最多 30 秒）", "Meeting Recorder: saving… (waiting for the last transcript lines, up to 30 seconds)"));
    this.proc.kill("SIGINT");
    // 錄音程式自己最多等 30 秒；45 秒還沒結束就強制結束（錄音檔在收尾的第一步就已經寫好）
    const proc = this.proc;
    rec.killTimer = setTimeout(() => proc.kill("SIGKILL"), 45000);
  }

  async finished(rec, code) {
    clearTimeout(rec.killTimer);
    if (this.recording === rec) { this.proc = null; this.recording = null; }
    this.refresh();
    rec.waiting?.hide();
    rec.stallNotice?.hide();
    await rec.queue;
    const summary = (rec.err().match(/■.*$/m) || [""])[0];

    if (rec.empty) {
      rec.state = "done";
      inFlight.delete(rec.id);
      await this.enqueue(rec, (t) => {
        const lines = t.split("\n");
        const { s, e, h } = this.locate(lines, rec);
        if (s >= 0 && e >= 0) lines.splice(s, e - s + 1);
        if (h >= 0) lines[h] = `${HEADING}${rec.label}${T("（沒有收到任何聲音）", " (no audio received)")}`;
        return lines.join("\n");
      });
      const hasVideo = rec.video?.path && fs.existsSync(rec.video.path);
      new Notice(hasVideo
        ? T(`錄音筆記：一秒都沒收到聲音，錄音沒有存檔。\n畫面有錄到（沒有聲音）：下載／螢幕錄影／${path.basename(rec.video.path)}`, `Meeting Recorder: no audio was received, so nothing was saved.\nThe video was recorded (without sound): Downloads/Screen Recordings/${path.basename(rec.video.path)}`)
        : T("錄音筆記：一秒都沒收到聲音，沒有存檔", "Meeting Recorder: no audio was received, so nothing was saved"), 20000);
      return;
    }
    const abs = path.join(this.app.vault.adapter.getBasePath(), rec.rel);
    if (!rec.saved && !(fs.existsSync(abs) && fs.statSync(abs).size > 4096)) {
      this.saveSession(rec, { state: "failed" });
      inFlight.delete(rec.id);
      await this.setHeading(rec, T("（存檔可能失敗）", " (saving may have failed)"));
      new Notice(T(`錄音筆記：存檔可能失敗（結束碼 ${code}）。暫存的聲音檔留在 ${rec.tmpdir}\n${rec.err().trim().slice(-400)}`, `Meeting Recorder: saving may have failed (exit code ${code}). Temporary audio files are kept in ${rec.tmpdir}\n${rec.err().trim().slice(-400)}`), 30000);
      return;
    }
    new Notice(T(`■ 錄音筆記已存檔，逐字稿精修中…\n${summary}`, `■ Meeting Recorder: saved. Refining the transcript…\n${summary}`), 8000);
    await this.afterSaved(rec);
  }

  // 錄音檔插進筆記，然後排隊做 whisper 精修
  async afterSaved(rec) {
    try {
      await this.afterSavedInner(rec);
    } catch (e) {
      // 這裡出錯不能讓這場錄音卡在「處理中」：標成失敗、放掉，之後可以用命令補做
      console.error("course-recorder afterSaved", e);
      inFlight.delete(rec.id);
      this.saveSession(rec, { state: "failed" });
      new Notice(T(`錄音筆記：錄音檔已存好，但沒能寫進筆記（${e}）。\n要重試：命令面板 →「Meeting Recorder: 補做沒完成的逐字稿精修」`, `Meeting Recorder: the audio file is saved but could not be written into the note (${e}).\nTo retry: Command palette → "Meeting Recorder: Finish incomplete transcript refinement"`), 30000);
    }
  }

  async afterSavedInner(rec) {
    rec.state = "refining";
    this.saveSession(rec);
    let file = null;
    for (let i = 0; i < 30 && !(file instanceof TFile); i++) {
      file = this.app.vault.getAbstractFileByPath(rec.rel);
      if (!(file instanceof TFile)) await new Promise((r) => setTimeout(r, 200));
    }
    await this.ensureNote(rec);
    const embed = file instanceof TFile ? "!" + this.app.fileManager.generateMarkdownLink(file, rec.noteFile.path) : T(`（錄音檔：${rec.rel}）`, `(audio file: ${rec.rel})`);
    const canRefine = fs.existsSync(path.join(rec.tmpdir, "course.wav"));
    let videoLine = null;
    if (rec.video?.path && fs.existsSync(rec.video.path)) {
      const off = Number.isFinite(rec.video.offset) ? rec.video.offset : 0;
      videoLine = `🎬 [${T("錄影：", "Video: ")}${path.basename(rec.video.path)}](file://${encodeURI(rec.video.path)}) %%video-offset ${off.toFixed(2)}%%`;
    }
    await this.setHeading(rec, canRefine ? T("（逐字稿 whisper 精修中…）", " (refining transcript with whisper…)") : "", [embed, videoLine]);
    if (!canRefine) { inFlight.delete(rec.id); return; }
    this.refineChain = this.refineChain
      .then(() => this.runRefine(rec))
      .catch((e) => console.error("course-recorder refine", e))
      .finally(() => inFlight.delete(rec.id));
  
  }

  // ---------- 錄完後：whisper 精修，取代即時逐字稿；截圖和使用者自己寫的內容保留 ----------
  async runRefine(rec) {
    await Promise.all(rec.ocrJobs);
    await this.processVideo(rec);
    const hints = [...rec.images, ...rec.slides].map((i) => i.ocr).filter(Boolean).join("\n");
    if (hints) fs.writeFileSync(path.join(rec.tmpdir, "hints.txt"), hints);
    // 截圖、投影片的時間：精修合併段落時在這裡斷開
    fs.writeFileSync(path.join(rec.tmpdir, "breaks.json"), JSON.stringify([...rec.images, ...rec.slides].map((i) => i.start)));
    let seconds = 0;
    try { seconds = fs.statSync(path.join(rec.tmpdir, "course.wav")).size / 32000; } catch (_) { /* 沒有就用預設 */ }

    const result = await new Promise((resolve) => {
      const p = spawn("/usr/bin/python3", ["-I", TRANSCRIBE, rec.tmpdir], { stdio: ["ignore", "pipe", "pipe"] });
      this.saveSession(rec, { refinePid: p.pid });
      let out = "", err = "";
      // 正常速度約是錄音長度的 1/30；給「10 分鐘＋錄音長度」還沒跑完就當作卡住
      const timer = setTimeout(() => { err += T("\n逾時，已中止", "\ntimed out, stopped"); p.kill("SIGKILL"); }, (600 + seconds) * 1000);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => { clearTimeout(timer); resolve({ segs: null, err: String(e) }); });
      p.on("exit", (code) => {
        clearTimeout(timer);
        let segs = null;
        try { if (code === 0) segs = JSON.parse(out); } catch (_) { segs = null; }
        resolve({ segs: Array.isArray(segs) ? segs : null, err });
      });
    });

    if (!result.segs) {
      this.saveSession(rec, { state: "failed", refinePid: null });
      await this.setHeading(rec, T("（whisper 精修失敗，以下是即時逐字稿）", " (whisper refinement failed; showing the live transcript)"));
      new Notice(T(`錄音筆記：whisper 精修失敗，保留即時逐字稿。\n要重試：命令面板 →「Meeting Recorder: 補做沒完成的逐字稿精修」\n${result.err.trim().slice(-300)}`, `Meeting Recorder: whisper refinement failed; the live transcript is kept.\nTo retry: Command palette → "Meeting Recorder: Finish incomplete transcript refinement"\n${result.err.trim().slice(-300)}`), 30000);
      return;
    }
    let keptImages = 0, keptLines = 0;
    const written = await this.enqueue(rec, (t) => {
      const lines = t.split("\n");
      const { s, e, h } = this.locate(lines, rec);
      const hasBlock = s >= 0 && e >= 0;
      const inner = hasBlock ? lines.slice(s + 1, e) : [];
      // 使用者在錄音中刪掉的截圖不要再放回來
      const images = hasBlock ? rec.images.filter((img) => inner.some((l) => img.names.some((n) => l.includes(n)))) : rec.images;
      keptImages = images.length;
      const items = [
        ...result.segs.map((x) => ({ start: x.start, text: segLine(x) })),
        ...images.map((i) => ({ start: i.start, text: imageLines(i) })),
        ...rec.slides.map((i) => ({ start: i.start, text: imageLines(i) })),
      ].sort((a, b) => a.start - b.start);
      const body = items.length ? items.flatMap((i) => i.text.split("\n")) : [T("（沒有辨識到內容）", "(nothing was recognized)")];
      if (!hasBlock) {
        // 標記被刪掉了：不猜位置，整份加在文末
        return `${t.replace(/\n*$/, "")}\n\n${HEADING}${rec.label}${T("（逐字稿）", " (transcript)")}\n${body.join("\n")}\n`;
      }
      // 使用者在逐字稿區塊裡自己寫的內容要留下來，放在逐字稿後面
      const mine = [];
      let inImage = false;
      for (const l of inner) {
        if (OWN_RE.test(l)) { inImage = l.includes("📷") || l.includes("🖼️"); continue; }
        if (inImage && /^\s+>/.test(l)) continue;
        inImage = false;
        if (l.trim() !== "") mine.push(l);
      }
      keptLines = mine.length;
      lines.splice(s, e - s + 1, ...body, ...(mine.length ? ["", ...mine] : []));
      if (h >= 0) lines[h] = `${HEADING}${rec.label}`;
      return lines.join("\n");
    });
    if (!written) {
      // 筆記沒寫成功：暫存留著，不能說完成
      this.saveSession(rec, { state: "failed", refinePid: null });
      new Notice(T(`錄音筆記：精修好的逐字稿寫不進筆記，暫存先留著。\n要重試：命令面板 →「Meeting Recorder: 補做沒完成的逐字稿精修」\n${rec.lastEditError || ""}`, `Meeting Recorder: the refined transcript could not be written into the note; temporary files are kept.\nTo retry: Command palette → "Meeting Recorder: Finish incomplete transcript refinement"\n${rec.lastEditError || ""}`), 30000);
      return;
    }
    rec.state = "done";
    fs.rmSync(rec.tmpdir, { recursive: true, force: true });
    const extra = [rec.slides.length ? T(`投影片 ${rec.slides.length} 頁`, `${rec.slides.length} slides`) : "", keptImages ? T(`截圖 ${keptImages} 張`, `${keptImages} screenshots`) : "", keptLines ? T(`保留你寫的 ${keptLines} 行`, `kept ${keptLines} lines you wrote`) : ""].filter(Boolean).join(T("、", ", "));
    new Notice(T(`✓ 錄音筆記：逐字稿已換成 whisper 精修版（${result.segs.length} 段${extra ? "、" + extra : ""}）`, `✓ Meeting Recorder: transcript replaced with the whisper version (${result.segs.length} segments${extra ? ", " + extra : ""})`), 8000);
  }

  // ---------- 錄影後處理：聲音合進影片、偵測投影片換頁並截圖、辨識文字 ----------
  async processVideo(rec) {
    rec.slides = rec.slides || [];
    const v = rec.video;
    if (!v?.path || !fs.existsSync(v.path) || rec.slidesDone) return;
    const audioAbs = path.join(this.app.vault.adapter.getBasePath(), rec.rel);
    const outdir = path.join(rec.tmpdir, "slides");
    const offset = Number.isFinite(v.offset) ? v.offset : 0;
    new Notice(T("錄音筆記：處理錄影中（合進聲音、擷取投影片）…", "Meeting Recorder: processing the video (adding audio, capturing slides)…"), 6000);
    const res = await new Promise((resolve) => {
      execFile("/usr/bin/python3", ["-I", VIDEO_POST, v.path, audioAbs, outdir, String(offset)],
        { timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
          try { resolve(err ? { error: String(errOut || err).slice(-300) } : JSON.parse(out)); }
          catch (e) { resolve({ error: String(e) }); }
        });
    });
    if (res.error) {
      new Notice(T(`⚠️ 錄影後處理失敗（錄音和逐字稿照常）：${res.error}`, `⚠️ Video post-processing failed (audio and transcript are fine): ${res.error}`), 15000);
      return;
    }
    if (res.muxed === false) {
      new Notice(T("⚠️ 錄音沒有合進錄影檔，那支影片沒有聲音（錄音檔本身在筆記裡，不受影響）", "⚠️ Audio was not merged into the video, so the video has no sound (the audio file in your note is fine)"), 20000);
    }
    if (res.truncated) {
      new Notice(T(`⚠️ 投影片超過 ${res.slides.length} 頁，後面的沒有截圖（錄影檔裡還看得到）`, `⚠️ More than ${res.slides.length} slides; later ones were not captured (they are still in the video)`), 20000);
    }
    // 截圖存進 vault（錄影檔之後會被刪，投影片要留下來）；文字辨識同時跑 3 張
    const made = await Promise.all((res.slides || []).map(async (sl, n) => {
      try {
        const name = `Slide ${rec.id}-${String(n + 1).padStart(3, "0")}.jpg`;
        const ocrJob = runOcr(sl.file);
        const p = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(name, rec.noteFile.path));
        const f = await this.app.vault.createBinary(p, fs.readFileSync(sl.file));
        return { kind: "slide", start: sl.t, link: "!" + this.app.fileManager.generateMarkdownLink(f, rec.noteFile.path), ocr: await ocrJob, names: fileNames(f.name) };
      } catch (e) { console.error("course-recorder slide", e); return null; }
    }));
    rec.slides = made.filter(Boolean);
    rec.slidesDone = true;
    this.saveSession(rec);   // 投影片也存進狀態檔：這之後才當掉的話，復原時不用重截
  }

  // ---------- 復原：上次沒做完的（Obsidian 中途關閉、當掉，或精修失敗） ----------
  async recoverOrphans(manual, round = 0) {
    let ids = [];
    try { ids = fs.readdirSync(TMP); } catch (_) { ids = []; }
    let found = 0, stillRunning = 0, leftover = 0, leftoverBytes = 0;
    for (const id of ids) {
      const tmpdir = path.join(TMP, id), sf = path.join(tmpdir, "session.json");
      let s;
      try { s = JSON.parse(fs.readFileSync(sf, "utf8")); } catch (_) { continue; }
      if (inFlight.has(s.id)) continue;   // 這場還在錄，或已經在排隊精修
      if (alive(s.pid, "course-recorder") || alive(s.refinePid, "transcribe.py")) { stillRunning++; continue; }   // 還在跑，不要重複做
      if (!manual && s.recovered) {   // 自動復原每場只試一次，避免每次啟動都重跑一樣的失敗
        leftover++;
        try { for (const n of fs.readdirSync(tmpdir)) leftoverBytes += fs.statSync(path.join(tmpdir, n)).size; } catch (_) { /* 算不出來就算了 */ }
        continue;
      }
      if (!fs.existsSync(path.join(tmpdir, "course.wav"))) { fs.rmSync(tmpdir, { recursive: true, force: true }); continue; }
      found++;
      const noteFile = s.note ? this.app.vault.getAbstractFileByPath(s.note) : null;
      const rec = { id: s.id, rel: s.rel, tmpdir, noteFile: noteFile instanceof TFile ? noteFile : null, label: s.label,
                    state: "refining", pid: null, refinePid: null, recovered: true, queue: Promise.resolve(),
                    images: (s.images || []).map((i) => ({ ...i, names: i.names || [] })), ocrJobs: [], gap: 0,
                    video: s.video || null, slides: s.slides || [], slidesDone: !!s.slidesDone, err: () => "" };
      inFlight.add(rec.id);
      this.saveSession(rec);
      new Notice(T(`錄音筆記：${s.label} 的錄音上次沒有做完，現在補做逐字稿精修`, `Meeting Recorder: the recording from ${s.label} was not finished last time; refining its transcript now`), 10000);
      await this.afterSaved(rec);
    }
    if (manual && !found) new Notice(stillRunning ? T("錄音筆記：還有錄音正在收尾，等它結束再試", "Meeting Recorder: a recording is still finishing; try again when it is done") : T("錄音筆記：沒有需要補做的錄音", "Meeting Recorder: nothing to finish"));
    // 啟動時上一場的錄音程式還在收尾（最長 30 秒）：過一下再查，最多查 5 次
    if (!manual && stillRunning && round < 5) setTimeout(() => this.recoverOrphans(false, round + 1), 30000);
    // 補做過一次還是沒完成的：暫存不會自己消失（每小時錄音約 230 MB），提醒一次
    if (!manual && round === 0 && leftover) {
      new Notice(T(`錄音筆記：有 ${leftover} 場錄音的逐字稿精修沒完成，暫存佔 ${Math.round(leftoverBytes / 1e6)} MB。\n重試：命令面板 →「補做沒完成的逐字稿精修」；不要了就刪掉 ~/.config/course-recorder/tmp/ 裡的資料夾`, `Meeting Recorder: ${leftover} recordings have unfinished transcript refinement, using ${Math.round(leftoverBytes / 1e6)} MB of temporary files.\nRetry: Command palette → "Finish incomplete transcript refinement"; or delete the folders in ~/.config/course-recorder/tmp/ if you do not need them`), 20000);
    }
  }

  // ---------- 點逐字稿的時間 → 從那裡播放 ----------
  onTimeClick(ev) {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const codeEl = ev.target.closest?.("code, .cm-inline-code");
    if (!codeEl) return;
    const timeText = codeEl.textContent.replace(/`/g, "").trim();
    if (!TIME_RE.test(timeText)) return;

    let view = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!view && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(codeEl)) view = leaf.view;
    });
    if (!view?.file) return;
    const text = view.getMode() === "source" ? view.editor.getValue() : view.data;
    const lines = text.split("\n");

    // 找出被點的是哪一行，確認是逐字稿的時間，再往上找最近的錄音檔
    let lineNo = -1;
    if (view.getMode() === "source") {
      try { lineNo = view.editor.offsetToPos(view.editor.cm.posAtDOM(codeEl)).line; } catch (_) { lineNo = -1; }
    } else {
      const li = codeEl.closest("li");
      if (!li || !li.textContent.trim().startsWith(timeText)) return;
      lineNo = lines.findIndex((l) => l.startsWith(`- \`${timeText}\` `));
    }
    if (lineNo < 0 || !lines[lineNo]?.startsWith(`- \`${timeText}\` `)) return;
    let link = null;
    for (let i = lineNo; i >= 0 && !link; i--) {
      const m = lines[i].match(RECORDING_RE);
      if (!m) continue;
      try { link = decodeURIComponent(m[1] || m[2]); } catch (_) { link = m[1] || m[2]; }
    }
    if (!link) return;
    const audio = this.app.metadataCache.getFirstLinkpathDest(link, view.file.path);
    if (!(audio instanceof TFile)) return;

    ev.preventDefault();
    ev.stopPropagation();
    const sec = parseTime(timeText);
    // 這段錄音有錄影、檔案也還在 → 用 QuickTime 跳到影片的那個畫面；錄影刪掉了就照舊播錄音
    for (let i = lineNo; i >= 0; i--) {
      const m = lines[i].match(VIDEO_RE);
      if (m) {
        let vpath = null;
        try { vpath = decodeURI(m[1].replace(/^file:\/\//, "")); } catch (_) { vpath = null; }
        if (vpath && fs.existsSync(vpath)) {
          this.player?.pause();
          this.openVideoAt(vpath, Math.max(0, sec - (parseFloat(m[2]) || 0)), timeText);
          return;
        }
        break;
      }
      if (isHeading(lines[i])) break;
    }
    if (!this.player) {
      this.player = new Audio();
      this.player.addEventListener("error", () => new Notice(T("錄音筆記：這個錄音檔播放不了（還在錄，或檔案損毀）", "Meeting Recorder: this audio file cannot be played (still recording, or the file is damaged)"), 8000));
    }
    const same = this.player.dataset.file === audio.path;
    if (same && !this.player.paused && this.player.dataset.time === timeText) {
      this.player.pause();
      new Notice(T("⏸ 停止播放", "⏸ Playback stopped"));
      return;
    }
    if (!same) { this.player.src = this.app.vault.getResourcePath(audio); this.player.dataset.file = audio.path; }
    this.player.dataset.time = timeText;
    const go = () => { this.player.currentTime = sec; this.player.play().catch(() => {}); };
    if (this.player.readyState >= 1) go(); else this.player.addEventListener("loadedmetadata", go, { once: true });
    new Notice(T(`▶ 從 ${timeText} 播放（再點一次同一個時間停止）`, `▶ Playing from ${timeText} (click the same time again to stop)`), 4000);
  }

  // QuickTime 打開錄影（已經開著就不重開）並跳到指定秒數
  openVideoAt(vpath, sec, label) {
    const script = [
      "on run argv",
      "  set p to item 1 of argv",
      "  set t to (item 2 of argv) as real",
      '  tell application "QuickTime Player"',
      "    activate",
      "    set d to missing value",
      "    repeat with x in documents",
      "      try",
      "        if POSIX path of (file of x as alias) is p then set d to contents of x",
      "      end try",
      "    end repeat",
      "    if d is missing value then set d to open (POSIX file p)",
      "    set current time of d to t",
      "    play d",
      "  end tell",
      "end run",
    ];
    const args = script.flatMap((l) => ["-e", l]).concat([vpath, sec.toFixed(2)]);
    execFile("/usr/bin/osascript", args, { timeout: 20000 }, (err, _o, errOut) => {
      if (err) new Notice(T(`錄音筆記：QuickTime 打不開錄影：${String(errOut || err).slice(-200)}\n第一次使用要允許 Obsidian 控制 QuickTime Player`, `Meeting Recorder: QuickTime could not open the video: ${String(errOut || err).slice(-200)}\nOn first use, allow Obsidian to control QuickTime Player`), 15000);
    });
    new Notice(T(`▶ 用 QuickTime 從 ${label} 播放錄影`, `▶ Playing the video in QuickTime from ${label}`), 4000);
  }
};
