# Live Translate (EN → VI) — Chrome Side Panel Extension

Real-time English speech-to-text + Vietnamese translation + AI-powered suggested answers in Chrome Side Panel. Hỗ trợ Tab Audio (tabCapture) và Microphone, dịch tự động qua Google Translate free API, gợi ý trả lời và tóm tắt qua Gemini / OpenAI-compatible provider.

## Features

- **Realtime Transcription**: Web Speech API (`en-US`, `continuous` + `interimResults`) với `SILENCE_THRESHOLD=1500ms` và `MAX_INTERIM_LENGTH=100`.
- **Dịch EN→VI tự động**: `translate.googleapis.com` per-utterance, highlight `vi-just-arrived`.
- **Tab Audio & Mic**: `chrome.tabCapture.getMediaStreamId` + loopback qua `AudioContext`, fallback sang mic. Speaker diarization heuristic local (RMS + spectral centroid).
- **Gợi ý trả lời AI** (`sidepanel.js:733`): phát hiện câu hỏi `isQuestion()` (regex `who/what/...` + `?`), gọi LLM qua `callProviderForSuggest()` để trả về `{"structures":3,"answers":3}`.
- **Rolling Compress 5 phút (B)** (`sidepanel.js:24`): toggle `🗜️ Nén 5p` — nén lịch sử định kỳ 5 phút bằng LLM thành bullet summary, prompt gợi ý sau đó dùng `compressed history + 10 câu gần nhất` thay vì chỉ 4 câu. Tiết kiệm token cho video dài, vẫn giữ ngữ cảnh.
- **Tóm tắt AI**: `generateSummary()` hỗ trợ Gemini native và OpenAI-compatible `/chat/completions`.
- **UI**: single transcript feed (EN trắng / VI vàng), live block với typing indicator, suggestion dock tách rời (Cả 2 / Cấu trúc / Câu hoàn chỉnh).

## Architecture

```
sidepanel.js
  ├─ SpeechRecognition (Web Speech) → finalizeText() → splitIntoUtterances()
  ├─ translateText() → Google Translate
  ├─ isQuestion() → triggerSuggestForIndex() → buildSuggestPrompt() → callProviderForSuggest()
  ├─ Compress: callProviderGeneric() → performCompression() ↔ start/stopCompressTimer() (5m interval)
  └─ renderCombined() / utteranceDomCache / autoScroll (sticky)
background.js: chrome.tabCapture.getMediaStreamId handler
manifest.json: permissions [sidePanel, activeTab, storage, tabCapture]
```

## Installation

1. Clone repo:
   ```bash
   git clone https://github.com/nbhson/app-live-translate-extension.git
   ```
2. Mở `chrome://extensions` → bật Developer mode → Load unpacked → chọn thư mục repo.
3. Click icon extension để mở Side Panel.

## Cấu hình AI Provider

Mở `⚙️` trong header → nhập:

- **Base URL**: `https://generativelanguage.googleapis.com/v1beta` (Gemini) / `https://api.openai.com/v1` / `http://localhost:11434/v1` (Ollama) / `https://api.groq.com/openai/v1`
- **API Key**: `AIza...` / `sk-...` (để trống nếu localhost)
- **Model**: `gemini-2.5-flash`, `gpt-4o-mini`, `llama3.1`, v.v.

Preset chips hỗ trợ 1-click. Lưu vào `chrome.storage.local` (`providerBaseUrl`, `providerApiKey`, `providerModel`). Check `updateApiWarningState()`.

## Gợi ý trả lời — Ngữ cảnh

- **Mặc định (toggle Nén tắt)**: `buildSuggestPrompt()` dùng `4 utterances gần nhất` (`slice(-4)`).
- **Bật Nén 5p** (`sidepanel.js:749`): 
  - Mỗi 5 phút `performCompression()` tóm tắt segment `finalizedEnPhrases.slice(lastCompressedIdx)` thành 3-5 bullets (≤150 words, `temperature 0.3`) qua `callProviderGeneric()`.
  - Lưu `compressedSummary` (giữ 6000 chars cuối) + `lastCompressedIdx` vào storage.
  - Khi có câu hỏi, prompt = `Compressed history (3000 chars) + Recent 10 utterances + Question` → LLM trả lời bám sát toàn bộ lịch sử, không chỉ 4 câu.
  - UI: toggle `🗜️ Nén 5p` trong control bar (`#compressToggle`), badge `Đã nén X câu`, status bar `#compressStatus`, nút `Nén ngay` trong dock (`#manualCompressBtn`).

```
Toggle OFF: Question → prompt(4 câu) → LLM
Toggle ON : 5m timer → compress → prompt(compressed + 10 câu) → LLM (context-aware)
```

## Usage

1. Chọn nguồn âm thanh (Tab Audio / Microphone), bấm **Bắt đầu** (Space).
2. Nói tiếng Anh → transcript EN/VI hiện realtime. Câu hỏi được highlight `?` và tự sinh gợi ý trong dock dưới.
3. Bật `🗜️ Nén 5p` nếu video dài (>15 phút) để gợi ý bám sát toàn bộ hội thoại.
4. Tab **Tóm tắt AI** → chọn `VI/EN` + `Chi tiết/Ngắn/Actions` → **Tóm tắt** → Copy.

## Permissions

- `sidePanel`, `activeTab`, `storage`, `tabCapture`
- `host_permissions`: `translate.googleapis.com`, `generativelanguage.googleapis.com`, `https://*/*`

## Development

```bash
# Check syntax
node --check sidepanel.js
# Reload extension sau khi edit: chrome://extensions → Reload
```

Files chính: `sidepanel.js` (~2300 lines), `sidepanel.html`, `sidepanel.css`, `background.js`, `manifest.json`.

## Changelog

- **2026-09-17**: Thêm Rolling Compress 5 phút + toggle (B), generic LLM call, `compressedSummary` persistence, manual compress.
- Trước đó: speaker VAD diarization, sticky live block, mockup transcript, suggestion dock.

## License

MIT — xem repo gốc.
