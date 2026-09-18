# Live Translate (EN → VI) — Chrome Side Panel Extension

Real-time English speech-to-text + Vietnamese translation + AI-powered suggested answers in Chrome Side Panel. Hỗ trợ **Tab Audio** (`chrome.tabCapture`) và **Microphone**; dịch tự động qua **Google Translate free API**; gợi ý trả lời, nén lịch sử 5 phút và tóm tắt cuộc họp qua **Gemini / OpenAI-compatible provider** (OpenAI, Ollama, Groq).

Version **1.0.1** · MV3 · MIT

---

## Tổng quan kiến trúc

```mermaid
flowchart TB
    subgraph Extension["Chrome Extension (MV3)"]
        BG["background.js<br/>(service worker)<br/>tabCapture.getMediaStreamId (Tab Audio)"]
        SP["sidepanel.html / sidepanel.js<br/>(side panel runtime ~2450 lines)"]

        subgraph Modules["src/ — modular ESM (testable)"]
            UTILS["src/utils<br/>isQuestion · splitIntoUtterances<br/>buildSuggestPrompt · parseSuggestAnswers<br/>sanitizePromptContext · escapeHtml<br/>computeSpectralCentroid · shouldToggleSpeaker"]
            SRV["src/services<br/>translate/ · llm/ · speech/ · storage"]
            STORE["src/state/store.js<br/>createStore — single source of truth"]
            CFG["src/config.js<br/>CONFIG constants"]
        end
    end

    subgraph AudioFeed["Nguồn âm thanh"]
        TAB["Tab đang phát audio<br/>googlevideo, meet, youtube..."]
        MIC["Microphone người dùng"]
    end

    subgraph External["External APIs"]
        GOOG["translate.googleapis.com<br/>(Human-style free EN→VI)"]
        LLM["Gemini / OpenAI-compatible LLM<br/>generativelanguage · api.openai<br/>localhost:11434 (Ollama) · groq"]
    end

    BG <-->|"runtime.onMessage: get-tab-stream-id"| SP
    TAB -->|"chrome.tabCapture.getMediaStreamId<br/>+ getUserMedia(tab)"| BG
    TAB -->|"MediaStream loopback"| SP
    MIC -->|"getUserMedia(audio)"| SP
    SP -->|"fetch"| GOOG
    SP -->|"fetch POST generateContent / chat/completions"| LLM
    UTILS <--> SP
    SRV <--> STORE <--> UTILS
    SRV -.->|"future ESM entry (dist/main.js hiện chưa load)"| SP
```

> **Ghi chú quan trọng:** file chạy thực tế là **`sidepanel.js`** (không module, load trực tiếp trong `sidepanel.html`). Các module **`src/`** là bản tái cấu trúc tương đương, được Vitest test và Vite build thành `dist/main.js` — nhưng `sidepanel.html` **đang comment out** thẻ `<script type="module" src="dist/main.js">` nên `src/` hiện là code chết về runtime. Hai bản phải là ảnh phản chiếu (mirror). Các chỉnh sửa sau đây đều sync cả 2 nơi.

---

## Features

- **Realtime Transcription**: Web Speech API (`en-US`, `continuous` + `interimResults`), `SILENCE_THRESHOLD = 900ms`.
- **Dịch EN→VI tự động**: Google Translate free API per-utterance, chunking `>4200 chars`, retry/backoff, LRU cache 500 entry.
- **Tab Audio & Mic**: `chrome.tabCapture.getMediaStreamId` + loopback qua `AudioContext`, fallback sang mic nếu tab không capturable.
- **Gợi ý trả lời AI**: `isQuestion()` phát hiện câu hỏi → `buildSuggestPrompt()` → LLM → `parseSuggestAnswers()` → Suggestion Dock (Cả 2 / Cấu trúc / Câu hoàn chỉnh).
- **Rolling Compress 5 phút**: toggle `🗜️ Nén 5p` — nén lịch sử định kỳ 5 phút thành bullet summaries; prompt gợi ý sau đó dùng `compressed history + 10 câu gần nhất`.
- **Tóm tắt AI**: `generateSummary()` hỗ trợ Gemini native (`:generateContent`) và OpenAI-compatible (`/chat/completions`).
- **Speaker diarization heuristic**: VAD local (RMS + spectral centroid) để phân biệt 2 người nói.
- **UI**: feed transcript đơn (EN trắng / VI vàng), layout ngược — *newest on top*, live block + typing indicator, suggestion dock tách rời.

---

## Flow 1 — Khởi động & Capture (Tab Audio / Mic)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as sidepanel.js
    participant BG as background.js
    participant TC as chrome.tabCapture
    participant SP as speakerMonitor (VAD)

    U->>UI: Chọn "Tab Audio" + bấm Bắt đầu
    UI->>BG: sendMessageAsync({type:'get-tab-stream-id'})
    BG->>BG: isCapturableTab(tab)
    alt Tab không capturable (chrome://, about:, chrome.google.com, file:)
        BG-->>UI: { error }
        UI->>UI: audioSourceSelect='mic' + showToast
        Note over UI: fallback sang Mic
    else Hợp lệ
        BG->>TC: getMediaStreamId({targetTabId})
        TC-->>BG: streamId
        BG-->>UI: { streamId }
        UI->>UI: getUserMedia({chromeMediaSource:'tab'})
        UI->>UI: MediaStreamSource → ctx.destination (loopback)
        UI->>SP: setupSpeakerMonitor(stream)
        UI->>SP: startListening()
    end

    alt Nguồn = Microphone
        U->>UI: Chọn Mic + Bắt đầu
        UI->>UI: setupMicSpeakerMonitor() → getUserMedia(audio)
        UI->>SP: setupSpeakerMonitor(micStream)
        UI->>UI: recognition.start()
    end
```

`isCapturableTab` (mirror trong `background.js:11` và `src/background/isCapturableTab.js`):
- Chỉ cho `http:` / `https:`.
- Chặn `chrome://`, `chrome-extension://`, `about:`, `edge://`, `file:`.
- Chặn host `chrome.google.com`, `chromewebstore.google.com`, `accounts.google.com`.

---

## Flow 2 — STT → Utterance → Live block

```mermaid
sequenceDiagram
    autonumber
    participant SR as SpeechRecognition (Web Speech)
    participant R as handleRecognitionResult
    participant P as parseRecognitionEvent
    participant L as ensureLiveUtterance / promoteLiveToFinal
    participant F as finalizeText
    participant V as VAD/speakerMonitor

    SR->>R: onresult (interim/final chunks)
    R->>P: parseRecognitionEvent(event)
    P->>R: { interimEn, finals }
    Note over P: guard event.results · confidence dưới 0.25 bỏ ·<br/>skip punctuation-only · dedup finals<br/>interim capped 200 chars
    R->>F: finalizeText(f) cho từng final
    R->>L: interim: ensureLiveUtterance()
    Note over L: tạo live slot (EN trống, VI '…') trên cùng feed
    R->>R: debounce: SILENCE_THRESHOLD=900ms
    R->>F: forceFinalizeText(interim) nếu đạt<br/>MAX_INTERIM_LENGTH=80 hoặc hết silence
    F->>F: splitIntoUtterances → push EN + placeholder VI
    V-->>F: currentSpeakerId (từ VAD) cho speaker badge
```

**Xử lý error / auto-restart** (`handleRecognitionError` / `handleRecognitionEnd`):

| Error | Xử lý |
|---|---|
| `not-allowed` / `service-not-allowed` | hiện Permission overlay + dừng |
| `no-speech` / `aborted` | bỏ qua, auto-restart |
| `audio-capture` | toast "Mic not found" + dừng |
| `network` | toast "STT network error — retrying", giữ chạy |
| khác | toast + dừng |

`onend` → nếu vẫn đang listen: reset `lastFinalIndex=-1`, auto-restart sau **300ms**.

---

## Flow 3 — Dịch EN→VI (Google Translate + chunk + retry + LRU)

```mermaid
flowchart TD
    A["finalizeText(text)"] --> B{"Text > 4200 chars?"}
    B -- "Có" --> C["chunkBySentence<br/>split theo (?&lt;=[.!?])\s+<br/>force-split phần &gt;4200"]
    C --> D["Dịch từng chunk (đệ quy, cân nhắc abort)"]
    D --> E["Join ' '.join"]
    B -- "Không" --> F{"Cache LRU hit?"}
    E --> F
    F -- "HIT" --> G["LRU touch → trả về ngay"]
    F -- "MISS" --> H["fetch translate.googleapis.com<br/>sl=en&tl=vi&client=gtx"]

    H --> I{"response.ok?"}
    I -- "429/5xx" --> J{"attempt < retries (2)?"}
    J -- "Có" --> K["backoff 400*2^attempt + jitter<br/>honor Retry-After header"]
    K --> H
    J -- "Hết retry" --> L["throw / trả ''"]
    I -- "OK" --> M{"json() trả text?"}
    M -- "Empty (transcript)" --> N{"attempt<retries?"}
    N -- "Có" --> O["delay 300*(attempt+1) → retry"]
    N -- "Không" --> P["trả ''"]
    M -- "Có text" --> Q["cache.set → return"]

    H -.->|"network error / Failed to fetch"| R{"retryable?"}
    R -- "Có & attempt<retries" --> S["backoff 350*2^attempt → retry"]
    R -- "không" --> T["trả ''"]

    Q --> U["translateBatchConcurrent (pool Max 3)<br/>setViText · copyVi.disabled · vi-just-arrived"]
```

**Chi tiết mô-đun `src/services/translate/`:**

| File | Vai trò |
|---|---|
| `translate.js` | `translateText()` — chunking 4200, retry 2 lần (429/5xx/network/empty), timeout `TRANSLATE_TIMEOUT_MS=8500`, link external abort, `_internals` cho test |
| `cache.js` | `createTranslateCache(limit=500)` — LRU thật, `safeLimit` clamp 1..2000, `get/set/has/delete/clear/size/keys` |
| `batch.js` | `translateBatchConcurrent(tasks, {concurrency=3})` — worker pool, bỏ qua task đã có VI, `'[Translation failed]'` không đánh dấu là giá trị cuối, `results.failed` telemetry |

> (Bản `sidepanel.js:1419` giữ logic tương đương nội bộ — sync thủ công.)

---

## Flow 4 — Phát hiện câu hỏi & Gợi ý trả lời AI

```mermaid
flowchart TD
    A["finalizeText → utterance EN"] --> B["isQuestion(utterance)"]
    B -- "Không phải câu hỏi" --> END["Bỏ qua (không gọi LLM)"]
    B -- "Là câu hỏi" --> C["triggerSuggestForIndex(idx, question)"]

    C --> D{"suggestEnabled && provider cấu hình?"}
    D -- "Chưa cấu hình" --> E["questionSuggestions[idx] = {state:'error'}"]

    D -- "OK" --> F["suggestQueue chỉ cho 1 LLM call<br/>đồng thời (queue serial)"]
    F --> G["contextSlice:<br/>compress ON → slice(-COMPRESS_RECENT_KEEP)<br/>compress OFF → slice(-4)"]

    G --> H["buildSuggestPrompt(question, ctx)"]
    H --> I["callProviderForSuggest(prompt)<br/>fetchWithRetry + fetchWithTimeout 30s<br/>Gemini :generateContent hoặc /chat/completions"]
    I --> J["parseSuggestAnswers(raw)"]
    J --> K{"answers/structures rỗng?"}
    K -- "Có" --> L["synthesizeStructures(ans) fallback"]
    K -- "Không" --> M["slice(0,3) structures + answers"]
    L --> M
    M --> N["updateDock() + updateSuggestCard(idx)<br/>Suggestion Dock: pills + Cả 2/Cấu trúc/Câu hoàn chỉnh"]
    E --> N
```

**`isQuestion()` — các lớp phát hiện** (`sidepanel.js:717`, `src/utils/isQuestion.js`):

1. Nhanh: có `?` → true.
2. `window.nlp` (compromise) nếu có → `doc.questions()`.
3. Loại trừ cảm thán: `What a ...!`, `How great ...!`.
4. **Declarative trap** `RE_DECLARATIVE_FALSE`: `This is correct.` không phải câu hỏi (trừ khi có tag/trailing `or`/embedded).
5. `RE_WH_START`: `who/what/when/where/why/how/which/...` + contraction `what's|how's|...` (≥2 từ, không kết thúc `!`).
6. `RE_AUX_START`: đảo trợ động từ `is|are|do|does|did|can|could|will|would|have|...`.
7. `RE_TAG_Q`: `, right?`, `, isn't it?`, `, yeah?`, `, huh?`.
8. `RE_EMBEDDED`: `do you|can you|would you mind|could you tell|...` (≥4 từ).
9. `RE_INDIRECT`: `do you know|tell me|any chance|let me know|...` (≥3 từ).
10. `RE_TRAILING_OR`: `or not|or what|or something|anything|somewhere` (≥4 từ).

**`buildSuggestPrompt()`** — chống injection: `sanitizePromptContext` thay `"""` → `"'"` trước khi nhúng vào block prompt; `truncateForPrompt` giới hạn recent ctx (1500 chars nén / 1000 chars thường).

**Provider** (`src/services/llm/provider.js`):
- `fetchWithTimeout(url, opts, timeout)` — internal AbortController link external `signal`.
- `fetchWithRetry(url, opts, timeout, maxRetries=2)` — retry 429/500/502/503/504 + `Retry-After`, drain body.
- `callProviderForSuggest` — systemPrompt bắt buộc "ONLY JSON" (OpenAI-compatible), Gemini dùng `temperature 0.8, maxOutputTokens 512`.
- `callProviderGeneric(prompt, cfg, {temperature=0.4, maxTokens=512, systemPrompt, timeout=25000})` — dùng cho compress.

**`parseSuggestAnswers()`** — strip code fence json wrapper (cả khối `` ```json ... ``` ``), `tryParseJson` (xoá trailing comma), nhận `{structures,answers}` hoặc mảng đơn, fallback bullet lines (≥3 ký tự), giới hạn 5.

---

## Flow 5 — Rolling Compress 5 phút (context-aware suggestions)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant UI as sidepanel.js
    participant ST as storage.local

    U->>UI: Bật toggle "🗜️ Nén 5p"
    UI->>UI: loadCompressPref() → compressEnabled=true
    alt đang listen
        UI->>UI: startCompressTimer() → setInterval 5 phút
    end

    loop Mỗi 5 phút (hoặc nút "Nén ngay")
        UI->>UI: performCompression(isManual)
        Note over UI: guard: compressInProgress ·<br/>pendingCount >= 2 · segment không rỗng
        UI->>UI: segment = finalizedEnPhrases.slice(lastCompressedIdx)
        Note over UI: cap 8000 chars (giữ phần mới nhất)
        UI->>LLM: callProviderGeneric(prompt, {temperature:0.3, maxTokens:300})<br/>"Summarize this conversation segment... 3-5 bullets, max 150 words"
        LLM-->>UI: summary
        UI->>UI: compressedSummary += "[+N unit @ HH:MM:SS]\n" + clean<br/>cap 6000 chars cuối · lastCompressedIdx = len(finalized)
        UI->>ST: storageSet({compressedSummary, lastCompressedIdx})<br/>(truncate string >8000 trong storageSet)
        UI-->>U: toast "Compressed N sentences" / badge "Đã nén X câu"
    end

    Note over UI: Prompt gợi ý khi compress ON:<br/>Compressed history (3000 chars) + Recent 10 utterances + Question
```

**Khi compress bật**, `triggerSuggestForIndex` lấy `contextSlice = finalizedEnPhrases.slice(max(0, idx-COMPRESS_RECENT_KEEP+1), idx+1)` (10 câu) thay vì 4.

---

## Flow 6 — Tóm tắt AI (Summary)

> Không thay đổi theo spec — `generateSummary` / `parseMarkdown` / `parseInlineMarkdown` giữ nguyên.

```mermaid
flowchart TD
    A["Bấm Tóm tắt AI"] --> B["getFullEnglishText()<br/>join tất cả finalizedEnPhrases"]
    B --> C{"Có nội dung?"}
    C -- "Không" --> ER["alert('No meeting content...')"]
    C -- "Có" --> D{"provider đủ config?"}
    D -- "Thiếu" --> ER2["mở settings + alert"]
    D -- "OK" --> E["Đọc lang (vi/en) + detail (bullets/short/action)"]

    E --> F{"lang == 'vi'?"}
    F -- "vi" --> G["Prompt tiếng Việt: bullets/2-3 đoạn/Action Items"]
    F -- "en" --> H["Prompt tiếng Anh tuỳ detail"]

    G --> I{"isGemini(baseUrl)?"}
    H --> I
    I -- "Gemini" --> J["POST {baseUrl}/models/{model}:generateContent?key=...<br/>contents[{parts[{text}]}]"]
    I -- "OpenAI-compatible" --> K["POST {baseUrl}/chat/completions<br/>messages[system+user] · temperature 0.7"]

    J --> L["candidates[0].content.parts[0].text"]
    K --> L["choices[0].message.content<br/>(fallback message.content / choices[0].text)"]
    L --> M{"Có text?"}
    M -- "Không" --> ER3["throw 'API returned no content'"]
    M -- "Có" --> N["parseMarkdown(candidateText)"]
    N --> O["summaryMarkdown.innerHTML = rendered<br/>datastore rawText để copy"]
    O --> P["toast 'Summarized with {model} successfully'"]

    N --> Q["parseInlineMarkdown — bold, headers, links, list"]
```

`parseMarkdown` xử lý: `###`/`##` headers → `<h3>`/`<h4>`, `**bold**`, `- bullets`, `\`code\``, URLs → `<a target=_blank>`.

---

## Flow 7 — VAD & Speaker Diarization (heuristic)

```mermaid
flowchart TD
    A["setupSpeakerMonitor(stream)"] --> B["guard: duplicate stream bỏ qua<br/>AudioContext resume"]
    B --> C["createMediaStreamSource + AnalyserNode<br/>fftSize=1024"]
    C --> D["setInterval tick 120ms"]

    D --> E["getByteTimeDomainData → RMS<br/>getByteFrequencyData → spectral centroid"]
    E --> F{"document.hidden?"}
    F -- "hidden" --> G["tạm dừng (clearInterval) để tiết CPU"]
    F -- "visible" --> H{"rms > SPEAKER_VAD_RMS_THRESH && not noise?"}
    H -- "Noise: centroid>6500 && rms<0.08" --> I["xem là silence"]
    H -- "Speech" --> J{"state==silence?"}
    J -- "Có" --> K["pauseLen >= SPEAKER_MIN_PAUSE_MS(350)?<br/>+ có lastSpeakerFeatures?"]
    K -- "Có" --> L{"shouldToggleSpeaker?<br/>so sánh |RMS diff| + |centroid diff| >= 320<br/>debounce 900ms"}
    L -- "Có" --> M["currentSpeakerId = (id+1)%2<br/>maybeCutLiveOnSpeakerChange()"]
    K -- "không" --> N["lastSpeakerFeatures = {rms,centroid}"]
    J -- "không" --> O["EMA alpha=0.15 làm mượt features"]
    M --> P["speakerVadSilenceMs = 0"]
    O --> P

    H -- "Silence" --> Q["state==speech và speechDur<600ms<br/>(SPEAKER_MIN_SPEECH_MS)?"]
    Q -- "giữ speech (debounce click)" --> R["không chuyển state"]
    Q -- "hết" --> S["state='silence' · speakerVadSilenceMs += dt"]
```

---

## Flow 8 — Utterance → DOM (newest on top) & Scroll

```mermaid
sequenceDiagram
    autonumber
    participant F as finalizeText
    participant U as ensureLiveUtterance / appendUtterance
    participant D as transcriptContent
    participant T as autoScroll

    F->>F: splitIntoUtterances()
    F->>U: appendUtterance(idx) cho từng utterance mới
    U->>U: buildUtteranceDom — EN span + VI span + copy buttons
    U->>D: prepend (DOM order = visual order, newest first)
    U->>U: applySpeakerToDom(cache, speakerId) — badge màu
    U->>D: pruneOldUtterances nếu > MAX_DOM_UTTERANCES(120)

    Note over U: live block: finalizeText trong live → promoteLiveToFinal<br/>(in-place, không jump) · typing indicator
    F->>T: autoScroll(true) — force scroll top
    T->>D: channel: autoScroll checkbox ON<br/>stick khi isNearTop() (scrollTop dưới 120)<br/>scrollTo({top:0, behavior})
```

**Chống XSS:** mọi nội dung người dùng/LLM đi qua `escapeHtml()` (`& < > " ' \``). `DOMPurify` có trong `package.json` và được import trong `src/main.js` (module mới), chưa được dùng trong `sidepanel.js` runtime.

---

## Cấu hình CONFIG (`src/config.js` ↔ `sidepanel.js` — mirror)

| Hằng số | Giá trị | Ý nghĩa |
|---|---|---|
| `SILENCE_THRESHOLD` | 900 ms | buộc finalize interim sau khi im lặng |
| `MAX_INTERIM_LENGTH` | 80 | finalize sớm nếu interim đạt 80 ký tự |
| `MAX_DOM_UTTERANCES` | 120 | prune DOM cũ khi vượt ngưỡng |
| `INTERIM_DEBOUNCE_MS` | 420 | debounce dịch interim (đã giảm từ 500) |
| `TRANSLATION_CACHE_MAX` | 500 | LRU size translate cache |
| `MAX_CONCURRENT_TRANSLATE` | 3 | pool dịch song song |
| `COMPRESS_INTERVAL_MS` | 5 phút | tần suất auto-compress |
| `COMPRESS_RECENT_KEEP` | 10 | số utterance gần nhất trong prompt nén |
| `COMPRESS_MAX_CHARS` | 3000 | cap compressedSummary khi build prompt |
| `SPEAKER_VAD_RMS_THRESH` | 0.012 | ngưỡng RMS xem là "có tiếng nói" |
| `SPEAKER_MIN_PAUSE_MS` | 350 | pause tối thiểu để tính speaker switch |
| `SPEAKER_MIN_SPEECH_MS` | 600 | speech tối thiểu trước khi chuyển silence |
| `SPEAKER_CENTROID_DIFF` | 320 | sai khác centroid tối thiểu để đổi speaker |
| `TRANSLATE_TIMEOUT_MS` | 8500 | timeout mỗi request dịch (đã tăng từ 8000) |

---

## Installation

1. Clone:

   ```bash
   git clone https://github.com/nbhson/app-live-translate-extension.git
   ```

2. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục repo.
3. Click icon extension để mở Side Panel. Cấu hình AI Provider lần đầu trong `⚙️`.

## Cấu hình AI Provider

- **Base URL**: `https://generativelanguage.googleapis.com/v1beta` (Gemini) / `https://api.openai.com/v1` / `http://localhost:11434/v1` (Ollama) / `https://api.groq.com/openai/v1`.
- **API Key**: `AIza...` / `sk-...` (để trống nếu localhost).
- **Model**: `gemini-2.5-flash`, `gpt-4o-mini`, `llama3.1`, ...
- Lưu vào `chrome.storage.local` (`providerBaseUrl`, `providerApiKey`, `providerModel`). Preset chips 1-click. `isValidProviderConfig()` kiểm tra `http/https` + model non-empty.

## Usage

1. Chọn nguồn (Tab Audio / Microphone) → **Bắt đầu** (hoặc Space).
2. Nói tiếng Anh → transcript EN/VI realtime. Câu hỏi được highlight `?` + tự sinh gợi ý trong dock.
3. Bật `🗜️ Nén 5p` cho video dài (>15 phút) để gợi ý bám sát toàn bộ lịch sử.
4. Tab **Tóm tắt AI** → chọn `VI/EN` + `Chi tiết/Ngắn/Actions` → **Tóm tắt** → Copy.

### Phím tắt

- **Space** — Start/Stop (xem `setupKeyboardShortcuts`, `sidepanel.js:2396`).
- Nút copy trên mỗi viên gạch transcript / card gợi ý.

## Permissions

```
permissions:        sidePanel, activeTab, storage, tabCapture
host_permissions:   https://translate.googleapis.com/*, generativelanguage.googleapis.com/*,
                    api.openai.com/*, api.groq.com/*, http://localhost/*, http://127.0.0.1/*
optional_host:      https://*/*            (thêm nếu cần url tuỳ ý → validate bằng isValidUrl)
```

## Development

```bash
npm install
npm test               # vitest run --coverage  (9 suites / 61 tests)
npm run test:watch
npm run build          # vite build → dist/main.js (43.6 kB, gzip 14.7 kB)
node --check sidepanel.js   # syntax check runtime script
```

**Checklist khi sửa code:**
1. Giữ mi **mirror** `sidepanel.js` ↔ `src/` (cùng hành vi). Nếu sửa gì trong `src/`, sửa tương ứng `sidepanel.js`.
2. `npm test` không được fail.
3. `node --check sidepanel.js && npm run build`.
4. Reload extension: `chrome://extensions` → Reload → thử cả Tab Audio và Mic.

### Viết test

```
tests/
  buildSuggestPrompt.test.js      — 4 ctx vs compress 10 ctx + 3000 truncation, sanitize triple-quotes, context injection
  isQuestion.test.js              — 11 cases (?, WH-start, aux, tag, embedded, indirect, exclamation exclusions, declarative trap)
  splitIntoUtterances.test.js     — 8 cases (empty, punctuation, WH keep, mid-split how, abbrev merge Mr./Dr., Safari fallback)
  parseSuggestAnswers.test.js     — object/array/bullet fallback, limit 5, synthesizeStructures, code fence
  sanitizePromptContext.test.js   — trim/slice, null-safe, triple-quote escape (khớp cài đặt mới)
  isCapturableTab.test.js         — schemes, chrome://, about:, blocked hosts
  computeSpectralCentroid.test.js — edge & branch
  shouldToggleSpeaker.test.js     — rms/centroid diff, debounce window
  escapeHtml.test.js              — entities
```

> **On test:** `src/services/*` hiện có 0% coverage (không tệp test). `src/utils` ~94–100%.

## File map

| File | Vai trò | Ghi chú |
|---|---|---|
| `sidepanel.js` | Runtime chính (side panel logic + UI) | ~2457 dòng; mirror các module `src/` |
| `sidepanel.html` / `sidepanel.css` | Layout & style | `dist/main.js` script đang comment out |
| `background.js` | SW: sidePanel behavior + `get-tab-stream-id` | mirror `src/background/isCapturableTab.js` |
| `manifest.json` | MV3 manifest, permissions, icons | |
| `permission.html` / `permission.js` | Overlay xin quyền mic/capture | |
| `src/…` | Modular duplicates (testable, build target) | chưa load runtime |
| `tests/` | Vitest suites | 61 tests |
| `lib/compromise.min.js` | NLP optional cho isQuestion | nếu load, tăng accuracy |

## Changelog

- **2026-09-18**: Đại cải thiện toàn diện (trừ Summary per spec):
  - Dịch: chunking 4200, retry backoff + `Retry-After`, LRU cache chuẩn (`cache.js`), worker pool abort-aware (`batch.js`).
  - `isQuestion`: contractions, tag words, embedded/indirect, `RE_DECLARATIVE_FALSE` trap.
  - `splitIntoUtterances`: `who/which`, abbrev merge, `\b` boundary, earliest split, STT contraction fallback.
  - `parseSuggestAnswers`: code fence, trailing comma, min length.
  - `sanitizePromptContext`: fix `"""` injection → `"'"`, control chars.
  - Provider: `fetchWithTimeout` + `fetchWithRetry` (429/5xx/Retry-After), empty-response throw, validation.
  - Compress: segment cap 8000, toast lỗi, re-read state after await.
  - STT/VAD: confidence<0.25 filter, punctuation-only skip, dedup finals, interim cap 200, error taxonomy, auto-restart 300ms, noise filter, `document.hidden` pause, EMA, min-speech debounce.
  - Storage: `lastError`-aware, size-cap 8000, `isValidProviderConfig`.
  - Config: `INTERIM_DEBOUNCE_MS 500→420`, `TRANSLATE_TIMEOUT_MS 8000→8500`.
  - Background: block `chrome://`, `about:`, `file:`, `chromewebstore.google.com`, `accounts.google.com`.
- **2026-09-17**: Thêm Rolling Compress 5 phút + toggle (B), generic LLM call, `compressedSummary` persistence, manual compress.
- **Trước đó**: speaker VAD diarization, sticky live block, mockup transcript, suggestion dock.

## License

MIT.