/**
 * Harness Ports — interface contracts for all external dependencies.
 * Core (store/services/utils) depends only on these ports, never on global chrome/window.
 * Adapters implement these ports for Chrome Extension; mocks implement for tests.
 * @module harness/ports
 */

/**
 * @typedef {Object} StoragePort
 * @property {(keys: string|string[]|object|null) => Promise<object>} get
 * @property {(obj: object) => Promise<void>} set
 * @property {(key: string) => boolean} isValidUrl
 * @property {(cfg: object) => boolean} isValidProviderConfig
 */

/**
 * @typedef {Object} ChromePort
 * @property {(msg: object) => Promise<any>} sendMessage
 * @property {() => Promise<boolean>} checkMicPermission
 * @property {(tab: chrome.tabs.Tab) => boolean} isCapturableTab
 * @property {(streamId: string) => Promise<MediaStream>} getTabMediaStream
 * @property {() => void} openPermissionTab
 */

/**
 * @typedef {Object} SpeechPort
 * @property {() => SpeechRecognition|null} createRecognition
 * @property {(event: any, ctx: object) => { interimEn: string, finals: string[], nextLastFinalIndex: number, nextOffset: number }} parseEvent
 * @property {(store: any, actions: any) => any} createHandlers
 */

/**
 * @typedef {Object} AudioPort
 * @property {(stream: MediaStream) => void} setupMonitor
 * @property {() => void} teardownMonitor
 * @property {(stream: MediaStream) => Promise<void>} setupMicMonitor
 * @property {(freqData: Uint8Array, sampleRate: number) => number} computeSpectralCentroid
 * @property {(feats: object, pauseLen: number, last: object, lastSwitchAt: number, now: number) => { shouldToggle: boolean, newSwitchAt: number }} shouldToggleSpeaker
 */

/**
 * @typedef {Object} LlmPort
 * @property {(url: string, opts: object, timeout: number) => Promise<Response>} fetchWithTimeout
 * @property {(url: string, opts: object, timeout: number, retries: number) => Promise<Response>} fetchWithRetry
 * @property {(prompt: string, cfg: object, opts?: object) => Promise<string>} callForSuggest
 * @property {(prompt: string, cfg: object, opts?: object) => Promise<string>} callGeneric
 * @property {(baseUrl: string) => boolean} isGemini
 */

/**
 * @typedef {Object} TranslatePort
 * @property {(text: string, opts?: object) => Promise<string>} translateText
 * @property {(tasks: any[], concurrency?: number) => Promise<string[]>} translateBatch
 * @property {(controllers: Set<AbortController>) => void} abortAll
 * @property {() => any} createCache
 */

/**
 * @typedef {Object} Harness
 * @property {StoragePort} storage
 * @property {ChromePort} chrome
 * @property {SpeechPort} speech
 * @property {AudioPort} audio
 * @property {LlmPort} llm
 * @property {TranslatePort} translate
 * @property {import('../state/store.js').store} store
 */

export const HarnessPorts = {};
