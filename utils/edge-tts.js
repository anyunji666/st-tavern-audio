// @ts-nocheck
// ═══════════════════════════════════════════════════════════
//  Edge-TTS（微软 Edge 内置在线语音合成）- 纯浏览器端 WebSocket 实现
//  无需 API Key。协议是社区广泛使用的公开逆向工程实现：
//  wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
//  参考: https://github.com/rany2/edge-tts
// ═══════════════════════════════════════════════════════════

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
// 拼接在 Sec-MS-GEC-Version 里的固定版本号，社区实现里通用的写法，不影响功能。
const CHROMIUM_FULL_VERSION = "130.0.2849.68";
const DEFAULT_TIMEOUT_MS = 15000;

// 内置常用音色（够用即可，之后可以自行扩充）
export const EDGE_VOICE_PRESETS = [
    { value: "zh-CN-XiaoxiaoNeural", label: "晓晓（女声·普通话）" },
    { value: "zh-CN-XiaoyiNeural", label: "晓伊（女声·普通话）" },
    { value: "zh-CN-YunjianNeural", label: "云健（男声·普通话）" },
    { value: "zh-CN-YunxiNeural", label: "云希（男声·普通话）" },
    { value: "zh-CN-YunxiaNeural", label: "云夏（男童声·普通话）" },
    { value: "zh-CN-YunyangNeural", label: "云扬（男声·普通话）" },
    { value: "zh-CN-liaoning-XiaobeiNeural", label: "晓北（女声·东北话）" },
    { value: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮（女声·陕西话）" },
    { value: "zh-HK-HiuMaanNeural", label: "曉曼（女声·粤语）" },
    { value: "zh-HK-WanLungNeural", label: "雲龍（男声·粤语）" },
    { value: "zh-TW-HsiaoChenNeural", label: "曉臻（女声·台湾腔）" },
    { value: "zh-TW-YunJheNeural", label: "雲哲（男声·台湾腔）" },
    { value: "en-US-AriaNeural", label: "Aria（女声·美式英语）" },
    { value: "en-US-GuyNeural", label: "Guy（男声·美式英语）" },
    { value: "en-US-JennyNeural", label: "Jenny（女声·美式英语）" },
    { value: "ja-JP-NanamiNeural", label: "七海（女声·日语）" },
    { value: "ja-JP-KeitaNeural", label: "圭太（男声·日语）" },
    { value: "ko-KR-SunHiNeural", label: "선히（女声·韩语）" },
    { value: "ko-KR-InJoonNeural", label: "인준（男声·韩语）" },
];

function createConcurrencyLimiter(limit) {
    const queue = [];
    let activeCount = 0;
    const next = () => {
        if (activeCount < limit && queue.length > 0) {
            activeCount++;
            const { fn, args, resolve, reject } = queue.shift();
            fn(...args).then(resolve).catch(reject).finally(() => {
                activeCount--;
                next();
            });
        }
    };
    return (fn) => (...args) => new Promise((resolve, reject) => {
        queue.push({ fn, args, resolve, reject });
        next();
    });
}

function genConnectionId() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 微软近年加的反爬校验参数：Windows纪元(1601-01-01)到现在的100ns ticks，
 * 向下取整到最近的5分钟，与 TrustedClientToken 拼接后 SHA-256，取大写十六进制。
 */
async function generateSecMsGec() {
    const WIN_EPOCH_OFFSET_SEC = 11644473600;
    let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH_OFFSET_SEC;
    ticks -= ticks % 300;
    const ticks100ns = BigInt(ticks) * 10000000n;
    const strToHash = `${ticks100ns.toString()}${TRUSTED_CLIENT_TOKEN}`;
    const data = new TextEncoder().encode(strToHash);
    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

function escapeXml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// 语速/音量默认按 % 处理，音调默认按 Hz 处理；只填数字时自动补单位，
// 已经带 %/Hz/正负号的原样透传。
function normalizeProsodyValue(v, unit) {
    if (v === undefined || v === null || String(v).trim() === "") return `+0${unit}`;
    let s = String(v).trim();
    if (!/^[+-]/.test(s)) s = `+${s}`;
    if (!/%$|Hz$/i.test(s)) s += unit;
    return s;
}

function guessLangFromVoice(voice) {
    const m = /^([a-z]{2,3}-[A-Z]{2})/.exec(String(voice || ""));
    return m ? m[1] : "zh-CN";
}

function buildSsml({ text, voice, rate, pitch, volume, lang }) {
    const r = normalizeProsodyValue(rate, "%");
    const p = normalizeProsodyValue(pitch, "Hz");
    const v = normalizeProsodyValue(volume, "%");
    const langAttr = lang || guessLangFromVoice(voice);
    return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langAttr}'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='${p}' rate='${r}' volume='${v}'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`;
}

function dateHeader() {
    // edge-tts 协议里常见的时间戳格式，值本身不影响解析，只要存在即可
    return new Date().toString() + " (Coordinated Universal Time)";
}

/**
 * 发起一次 Edge-TTS 合成请求（纯API客户端，不含缓存/去重逻辑）。
 * @param {object} req
 *   @param {string} req.text
 *   @param {string} req.voice     如 zh-CN-XiaoxiaoNeural
 *   @param {string} [req.rate]    如 "+10%"，留空视为 "+0%"
 *   @param {string} [req.pitch]   如 "-5Hz"，留空视为 "+0Hz"
 *   @param {string} [req.volume]  如 "+0%"
 *   @param {string} [req.lang]    不填则从 voice 前缀推断
 *   @param {number} [req.timeoutMs]
 * @returns {Promise<{audioBuffer: ArrayBuffer}>}
 */
async function synthesize(req) {
    const { text, voice, rate, pitch, volume, lang, timeoutMs = DEFAULT_TIMEOUT_MS } = req || {};
    if (!text || !voice) throw new Error("Edge-TTS 缺少 text 或 voice 参数");

    const connectionId = genConnectionId();
    const gec = await generateSecMsGec();
    const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}` +
        `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;

    return new Promise((resolve, reject) => {
        let settled = false;
        const audioChunks = [];
        let totalBytes = 0;
        let ws;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            reject(new Error(`Edge-TTS 连接创建失败: ${e?.message || e}`));
            return;
        }
        ws.binaryType = "arraybuffer";

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { ws.close(); } catch (e) { /* noop */ }
                reject(new Error(`Edge-TTS 请求超时 (${timeoutMs / 1000}s)`));
            }
        }, timeoutMs);

        function finish() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch (e) { /* noop */ }
            if (totalBytes > 0) {
                const merged = new Uint8Array(totalBytes);
                let offset = 0;
                for (const c of audioChunks) { merged.set(c, offset); offset += c.length; }
                resolve({ audioBuffer: merged.buffer });
            } else {
                reject(new Error("Edge-TTS 未返回任何音频数据（可能是音色名不存在，或微软临时限制了访问）"));
            }
        }

        ws.onopen = () => {
            const now = dateHeader();
            const configMsg =
                `X-Timestamp:${now}\r\n` +
                `Content-Type:application/json; charset=utf-8\r\n` +
                `Path:speech.config\r\n\r\n` +
                JSON.stringify({
                    context: {
                        synthesis: {
                            audio: {
                                metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                            },
                        },
                    },
                });
            ws.send(configMsg);

            const ssml = buildSsml({ text, voice, rate, pitch, volume, lang });
            const ssmlMsg =
                `X-RequestId:${connectionId}\r\n` +
                `Content-Type:application/ssml+xml\r\n` +
                `X-Timestamp:${now}\r\n` +
                `Path:ssml\r\n\r\n` +
                ssml;
            ws.send(ssmlMsg);
        };

        ws.onmessage = (event) => {
            if (typeof event.data === "string") {
                if (event.data.includes("Path:turn.end")) finish();
                return;
            }
            // 二进制消息：前2字节(大端)是header文本长度，之后是header文本，再之后才是音频数据
            const buf = new Uint8Array(event.data);
            if (buf.length < 2) return;
            const headerLen = (buf[0] << 8) | buf[1];
            const headerText = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
            if (!headerText.includes("Path:audio")) return;
            const audioData = buf.subarray(2 + headerLen);
            if (audioData.length) {
                audioChunks.push(audioData);
                totalBytes += audioData.length;
            }
        };

        ws.onerror = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error("Edge-TTS 连接出错（网络问题，或微软临时限制了访问）"));
            }
        };

        // 服务端提前关闭但没收到 turn.end 时，用已收到的数据兜底结束
        ws.onclose = () => finish();
    });
}

/**
 * 初始化 Edge-TTS 客户端（带并发限制）。
 * @param {number} concurrency
 * @returns {(requestData: object) => Promise<{audioBuffer: ArrayBuffer}>}
 */
export function initEdgeTtsApi(concurrency = 3) {
    const limitedSynthesize = createConcurrencyLimiter(concurrency)(synthesize);
    return async (requestData) => {
        const { text, voice } = requestData || {};
        if (text && voice) return limitedSynthesize(requestData);
        throw new Error("Edge-TTS 请求参数不完整（需要 text/voice）。");
    };
}
