# Plan — app-live-translate-extension

> Chrome MV3 extension: Side Panel real-time STT (EN) + translate (VI), speaker VAD,
> AI suggest/summary, streaming. `sidepanel.js` 4.7k lines + `src/` mirrors + tests.

## Kết quả Review (audit đợt 1)

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| 1 | MAJOR | sidepanel.js:4395,4410 | `callSummaryLLMSide` bare `fetch` KHÔNG timeout — Summary button treo loading vĩnh viễn khi upstream stall | `fetchWithRetrySidepanel(url, …, 45000, 1)` cả 2 nhánh Gemini/OpenAI |
| 2 | MAJOR | sidepanel.js:1942,1977 | Streaming fast-paths (Gemini + OpenAI suggest) bare `fetch` không timeout/abort — SSE stall để `State.suggestInFlight` pending vĩnh viễn, chặn retry cho hash đó | `fetchWithRetrySidepanel(…, 20000, 0)` |
| 3 | MAJOR | sidepanel.js:1468 | `for (const f of finals) void finalizeText(f)` chạy CONCURRENT trong khi finalizeText await translate rồi mutate shared arrays/DOM index → duplicate/misplace utterances | Chain tuần tự qua `reduce(Promise.resolve → finalizeText)` |
| 4 | MAJOR | sidepanel.js:2245-2311 | Suggest results ghi `questionSuggestions[idx]` theo idx STALE — `splitUtteranceAt`/`compactTranscriptMemory` re-index map trong lúc LLM call → suggestion dính nhầm slot / resurrect slot đã drop | `suggestionSlotFor(idx, question)` re-key theo question tại mọi điểm ghi async (inflight await, onChunk stream, result, error, finally) |
| 5 | MAJOR | sidepanel.js:1495 | STT auto-restart fixed 300ms vô hạn — tight restart/error loop khi STT fail liên tục | Exponential backoff (cap 4s) + max 10 lần liên tiếp rồi stopListening |
| 6 | MAJOR | sidepanel.js:3160-3171 | `translateViaGoogleSide`: khi caller truyền external signal, fetch dùng `opts.signal` thay `controller.signal` → TRANSLATE_TIMEOUT_MS KHÔNG áp dụng (interim preview hang vô hạn) | Luôn fetch với `controller.signal` (external abort đã bridge qua handler) |
| 7 | MINOR | sidepanel.js:878 | `!nowCollapsed === false` — cùng giá trị boolean nhưng cực kỳ dễ đọc nhầm | `if (nowCollapsed)` + comment |
| 8 | MINOR | src/services/translate/batch.js:35 | Error path ghi `finalizedViPhrases[cur]` (slot vòng lặp worker) thay vì `t.idx` → đánh dấu NHẦM utterance failed | `finalizedViPhrases[t.idx]` |
| 9 | MINOR | sidepanel.js 6+ chỗ | `baseUrl.includes('localhost')` khớp cả `https://evil.com/?x=localhost` → remote host được coi là local (bỏ qua API key) | `isLocalHostUrl()` parse hostname; `isGeminiHostUrl()` tương tự cho 3 chỗ Gemini check |
| 10 | MINOR | manifest.json | `optional_host_permissions ["https://*/*"]` KHÔNG BAO GIỜ được request runtime — custom base URL ngoài mặc định fail fetch ngầm | Request permission lúc save provider config (đúng user gesture), warn nếu denied |
| 11 | MINOR | sidepanel.js:1934 | `curMax` ternary 3 nhánh với 2 nhánh giống hệt | Gộp 2 nhánh |
| 12 | MINOR | sidepanel.js:1615-1620,1598 | Dead code: RE_IMPERATIVE_DO branch if/else rỗng; regex `/^what\s+a\b/` trùng `/^what\s+a(n)?\b/` | Bỏ |
| 13 | MINOR | sidepanel.js:2244 | Suggest cache entry hết hạn không bị xóa, chiếm slot trong budget 80 | `delete` khi đọc thấy expired |
| 14 | MINOR | sidepanel.js:3468 | `handleCopy` không catch `clipboard.writeText` — unhandled rejection khi permission denied | try/catch + toast |
| 15 | MINOR | sidepanel.js:4064-4079,4134 | `alert()` blocking ×3 + raw `error.message` (endpoint details/JSON fragments) render vào summary | `showToast` + fixed message, detail chỉ console |
| 16 | MINOR | sidepanel.js:1289-1325 | `setupSpeakerMonitor` tạo MediaStreamSource mỗi start, teardown chỉ suspend — node leak mỗi start/stop cycle | Giữ `speakerMonitorSource`, disconnect trong teardown |
| 17 | MINOR | package.json | `dompurify` khai báo ở cả dependencies + devDependencies nhưng không import đâu cả | Remove cả 2 + lockfile |
| 18 | MINOR | repo root | Screenshot 2.2MB với space trong tên committed | `git rm` |

## Không sửa (đã cân nhắc, ghi nhận)

- **`"tabs"` permission**: code `chrome.tabs.query({active:true})` + cần URL của active tab cho `isCapturableTab` ngay khi sidepanel mở (activeTab grant có thể đã hết hiệu lực) — rút permission là behavior risk cho tính năng chính; đã ghi nhận.
- **sidepanel.js duplicate provider/translate code vs `src/services/*`** (1902, ~2000 dòng hand-maintained mirror): cần build pipeline bundle chung — refactor lớn, đã ghi drift (thresholds lệch) làm follow-up.
- **localStorage ↔ chrome.storage lang/theme dual persistence** (637-654): cần chọn single source of truth — follow-up.
- **`checkMicPermission` fallback luôn return false** (1138): cần getUserMedia probe thật — kèm permission page flow hiện tại, follow-up.
- **`isCapturableTab` triplicate**: bản canonical ở `src/background/isCapturableTab.js` (có test) — runtime copy trong background.js/sidepanel.js chưa import được do extension không bundle; cần thêm build step cho SW — follow-up.

## Round 2 (2026-10-29) — enterprise upgrade đợt 2

### Findings (deep review)

| # | Severity | Vị trí | Vấn đề | Fix |
|---|----------|--------|--------|-----|
| R2-1 | MAJOR | src/services/llm/provider.js, src/services/translate/providers.js | Canonical modules vẫn dùng `baseUrl.includes('localhost')` — Round 1 chỉ fix bản copy trong sidepanel.js (#9). Canonical là bản sẽ được bundle dùng chung → phải nâng lên hostname check trước khi dedupe | `src/utils/isLocalHostUrl.js` dùng chung |
| R2-2 | MAJOR | sidepanel.js vs src/services | Drift còn lại: canonical MyMemory không nhận `timeoutMs` theo CONFIG; sidepanel thiếu `responseStatus` strict check; LLM suggest sidepanel không forward `signal` | Gom về canonical, chọn semantics chặt hơn mỗi case |
| R2-3 | MAJOR | background.js (root) | Copy tay `isCapturableTab` thứ 2 (canonical có test nhưng không runtime-import được vì không có build step cho SW) | Vite build module SW từ `src/background/worker.js` |
| R2-4 | MAJOR | tests/portedFeatures.test.js | `computeMemoryMeta` test còn ngưỡng budget 6000 cũ (3600→warn) trong khi MEMORY_BUDGET đã 30000 → fail pre-existing | Test theo % tỉ lệ với budget 30000 |
| R2-5 | MINOR | sidepanel.css + live-new.css | Thiếu focus-visible ring thống nhất, `prefers-reduced-motion`, theme default không tôn trọng `prefers-color-scheme` | Tokens + a11y layer additive |
| R2-6 | MINOR | manifest | Không có options page, không có commands; popup KHÔNG thêm được — action click phải giữ gesture cho tabCapture (activeTab) | Options page riêng + commands |
| R2-7 | MINOR | UX | Transcript mất khi đóng side panel (không persist session) | Session auto-save/restore |

### Plan Round 2

1. **Dedupe follow-up**: `src/utils/isLocalHostUrl.js` shared util; canonical llm/translate providers dùng nó; sidepanel gọi qua shared bundle.
2. **Build pipeline follow-up**: Vite multi-entry — `dist/shared.js` (IIFE global `LiveTranslateShared` cho sidepanel.js classic script) + `dist/background.js` (module SW import canonical isCapturableTab) + `dist/main.js`. Manifest trỏ SW vào dist. `npm run build` là bắt buộc trước khi load extension.
3. **Features**: (a) History archive + search + export (.txt/.json), (b) session auto-save/restore qua sidepanel reopen, (c) global shortcut qua `chrome.commands` (Alt+Shift+L) + per-site disable list, (d) options page dùng chung design system.
4. **UI/UX**: focus-visible thống nhất, prefers-reduced-motion, prefers-color-scheme default, polish options/history.
5. Verify: vitest + build; self-review diff.

## Round 2 — Trạng thái

- [x] Plan
- [x] R2-1..R2-3 dedupe + build pipeline (shared bundle + module SW)
- [x] R2-4 fix test memoryMeter (pre-existing fail giờ xanh)
- [x] R2-5 UI/a11y polish
- [x] R2-6/R2-7 features: history+export, session restore, commands shortcut, per-site disable, options page
- [x] Commit + self-review

## Round 2 — Verification pass (re-run 2026-10-29)

Independent verify + self-review trên HEAD sau khi Round 2 commit xong:

- `npm test`: **225/225 pass** (29 files). `npm run build`: 3 bundle OK (`dist/main.js` 85KB, `dist/shared.js` 24KB, `dist/background.js` 4.6KB). `npm run lint` (`node --check` × 3 entry) OK. Không còn test fail pre-existing (R2-4 đã fix từ đợt trước, verified xanh).
- Manifest check: SW = `dist/background.js` (module), options page + `commands` wired, CSP `script-src 'self'; object-src 'none'; base-uri 'none'`, host_permissions không mở rộng; `dist/` gitignored (build artifact).
- Review log (self-review bắt thêm 1 bug thật):
  - `siteMatch.js`: `pathname.startsWith(pPath + '?')` là dead code — `URL.pathname` không bao giờ chứa query; pattern dạng `example.com/meet?id=1` vì vậy không bao giờ match. Fix: strip query trong `normalizeSitePattern`, bỏ dead condition; +1 test case.
  - Ghi nhận (không sửa): `flashOffBadge` dùng `setTimeout` trong SW — worker có thể bị kill trước khi badge nhấp nháy xong; dùng `chrome.alarms` sẽ tốn thêm permission "alarms" → không đáng, chấp nhận badge đôi khi kèm theo (đã có console.info log).
  - Ghi nhận: `"tabs"` permission giữ nguyên theo quyết định Round 1 (đã cân nhắc lại — cần URL active tab cho `isCapturableTab` khi mở panel).

## Trạng thái

- [x] Plan
- [x] Fix #1–#9, #11–#18
- [x] `node --check` 3 entry files OK; vitest **204/205 pass** (1 fail pre-existing — fail cả trên HEAD sạch, đã verify bằng stash)
- [x] Commit + self-review

## Round 3 (2026-10-29) — Sidepanel ESM migration

### Findings / scope

- `sidepanel.js` (4.7k dòng, classic script) vẫn tiêu thụ shared bundle qua global `globalThis.LiveTranslateShared` (28 điểm gọi `Shared.*`) — dependency gián tiếp, khó tree-shake, không thấy được import graph.
- `options.js` cũng dùng global bundle (escapeHtml/siteMatch/history/sessions).
- `permission.js` không dùng bundle — giữ classic script.
- Canonical `src/services/*`, `src/utils/*` đã có test đầy đủ → sidepanel import trực tiếp là an toàn, không cần adapter mới.

### Plan Round 3

1. `sidepanel.js` → ES module: import trực tiếp từ `src/services/*` + `src/utils/*`, bỏ toàn bộ `Shared.*` indirection (giữ tên wrapper để tối thiểu diff).
2. `options.js` → ES module (rẻ, cùng pattern).
3. Build mới `vite.sidepanel.config.js`: ESM entries `sidepanel.js → dist/sidepanel.js`, `options.js → dist/options.js` (tên file deterministic, chunk chung `dist/chunks/sessions.js`).
4. `sidepanel.html` / `options.html`: `<script type="module" src="dist/*.js">` (MV3 extension pages hỗ trợ module). Bỏ `<script src="dist/shared.js">`.
5. Giữ `dist/shared.js` + `sharedEntry.test.js`: bundle vẫn là hợp đồng export canonical (không trang nào tiêu thụ nữa nhưng test giữ 225/225 và làm guard cho export surface).
6. `permission.js` giữ classic script (45 dòng, không phụ thuộc gì).

## Round 3 — Trạng thái

- [x] sidepanel.js → ESM (28 điểm `Shared.*` → import trực tiếp; tên wrapper giữ nguyên)
- [x] options.js → ESM
- [x] vite.sidepanel.config.js + build script 4 bundles; HTML `type="module"`
- [x] Verify: `npm test` **225/225 pass** (29 files); `npm run build` OK (main 85KB, sidepanel 145KB + chunk sessions 3.4KB, options 3.9KB, shared 24KB, background 4.6KB); `npm run lint` OK (node --check × 4, ESM parse)
- [x] Verify chương trình (`plan/verify-round3.cjs`): mọi script/link trong 3 HTML tồn tại; script `dist/` đều `type="module"`; toàn bộ relative import trong dist entries resolve được (dist/sidepanel.js → chunks/sessions.js); không còn consumer runtime của `LiveTranslateShared` (chỉ còn comment). ALL-PATHS-OK.
- [x] Manifest không đổi: side_panel → sidepanel.html, options_ui → options.html, SW dist/background.js (module); CSP không đổi (script-src 'self' cho phép module script cùng origin).
- [x] Commit (local, KHÔNG push) + self-review

### Self-review log (Round 3)

- Tên import trùng local `const` (isLocalHostUrl, escapeHtml, sanitizePromptContext, computeSpectralCentroid…) → xóa wrapper `const`, dùng binding import trực tiếp; `node --check` xác nhận không duplicate declaration.
- Namespace imports đặt tên tránh collision với biến cục bộ: `historyStore` (không dùng `history` — trùng `window.history`), `sessionStore`, `siteMatch`.
- `type="module"` = defer mặc định → tương đương `defer` cũ, DOM sẵn sàng khi script chạy; HTML không có inline handler nào phụ thuộc global của sidepanel.js (đã grep).
- Chia chunk chung giữa 2 entry là ESM chuẩn (relative import trong dist) — đã walk import graph.

### Remaining risks (Round 3)

- `dist/` là build artifact (gitignored): load extension REQUIRES `npm run build` trước — giờ áp dụng cho cả sidepanel + options (trước đây chỉ sidepanel qua shared.js). Đã ghi chú trong HTML comment.
- Shared bundle `dist/shared.js` hiện không còn trang nào tiêu thụ → có thể xóa build + `sharedEntry.test.js` ở Round 4 (sẽ giảm test count; giữ lại vì task yêu cầu 225 tests green).
- `permission.js` vẫn classic script — không đáng ESM hóa (45 dòng, standalone).
- Chưa smoke-test runtime trong Chrome thật (không có harness chrome trong CI) — rủi ro thấp vì chỉ đổi cơ chế nạp code, không đổi logic; logic đã qua 225 tests qua bản canonical.


## Review Log

### Vòng 1
- Self-review bắt 1 lỗi tự gây: edit permission-request block làm duplicate `const toSave` + cắt mất callback body của `saveNow` (SyntaxError do `node --check` bắt) — đã khôi phục đầy đủ.
- `suggestionSlotFor` dùng `Object.keys(...).findIndex` trên string keys rồi `Number(found)` — ĐÚNG index mảng vì keys của object là string index; đã tự kiểm với map rỗng/stale.
- Thay `isLocalHostUrl` toàn repo: URL invalid giờ trả `false` (treated as remote) → save settings yêu cầu API key cho URL không parse được — chặt hơn trước, khớp intent.
- Stream fast-path fetch giờ qua `fetchWithRetrySidepanel` với `maxRetries: 0` — không đổi retry semantics, chỉ thêm timeout.
