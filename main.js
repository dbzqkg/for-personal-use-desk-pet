/**
 * Live2D 桌宠 - 主进程
 * 透明无边框窗口 + 本地模型文件协议(live2d://) + 托盘 + 右键菜单 + 配置持久化
 */
const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, screen, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 繁体→简体（opencc-js，纯 JS 离线；缺包时原样返回）
let tw2cn = t => t;
try {
  const OpenCC = require('opencc-js');
  const conv = OpenCC.Converter({ from: 'tw', to: 'cn' });
  tw2cn = t => { try { return conv(String(t)); } catch (e) { return t; } };
} catch (e) {}

const isSmoke = process.argv.includes('--smoke');
const isDiag = process.argv.includes('--diag');
const APP_DIR = __dirname;
const MODELS_DIR = path.join(APP_DIR, 'models');
const WHISPER_EXE = path.join(APP_DIR, 'vendor', 'whisper', 'whisper', 'Release', 'whisper-cli.exe');
const WHISPER_MODEL = path.join(APP_DIR, 'vendor', 'whisper', 'ggml-small.bin');
const SHERPA_BIN = path.join(APP_DIR, 'vendor', 'sherpa', 'sherpa-onnx-v1.13.5-win-x64-shared-MD-MinSizeRel-no-tts', 'bin');
const SHERPA_ASR_EXE = path.join(SHERPA_BIN, 'sherpa-onnx-vad-with-offline-asr.exe');
const SHERPA_MODEL = path.join(APP_DIR, 'vendor', 'sherpa', 'model.int8.onnx');
const SHERPA_TOKENS = path.join(APP_DIR, 'vendor', 'sherpa', 'tokens.txt');
const SHERPA_VAD = path.join(APP_DIR, 'vendor', 'sherpa', 'silero_vad.onnx');
// 用户提供的 VTS 模型目录（首次启动自动收录）
const SEED_MODEL_DIRS = ['D:\\重音テト\\VTS Model File\\重音テト', 'D:\\重音テト\\VTS Model File'];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// ---------- 日志 ----------
const logFile = () => path.join(app.getPath('userData'), 'app.log');
function log(...args) {
  try {
    const line = `[${new Date().toLocaleTimeString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const f = logFile();
    fs.appendFileSync(f, line + '\n');
    if (fs.statSync(f).size > 512 * 1024) {
      // 简单截断，保留后半部分
      const buf = fs.readFileSync(f, 'utf8');
      fs.writeFileSync(f, buf.slice(-256 * 1024));
    }
  } catch {}
  if (isSmoke) console.log(...args);
}

// ---------- 自定义协议：live2d://m/<编码后的模型根目录>/<相对路径> ----------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'live2d',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function absModelUrl(rootDir, relPath) {
  const segs = [rootDir, ...String(relPath).split(/[\\/]/)].map(encodeURIComponent);
  return 'live2d://m/' + segs.join('/');
}

function registerModelProtocol() {
  protocol.handle('live2d', async (request) => {
    try {
      const u = new URL(request.url);
      const parts = u.pathname.split('/').filter(Boolean).map(s => {
        try { return decodeURIComponent(s); } catch { return s; }
      });
      if (parts.length < 2) return new Response('bad request', { status: 400 });
      const root = parts[0];
      const rel = parts.slice(1).join(path.sep);
      const p = path.normalize(path.join(root, rel));
      const relToRoot = path.relative(path.normalize(root), p);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        return new Response('forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(p).toString());
    } catch (e) {
      log('protocol error:', e && e.message);
      return new Response('error', { status: 500 });
    }
  });
}

// ---------- 配置 ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  models: [],       // [{ name, path, rel }]
  current: 0,
  scale: 1,
  pos: null,        // { x, y }
  alwaysOnTop: true,
  clickThrough: false,
  scanDirs: [],     // 额外扫描目录
  quality: 'high',  // 渲染质量：high=跟随系统DPI / compat=低清兼容（显示不全时使用）
  powerSave: true,  // 省电模式：窗口失焦时降低渲染帧率
  camSens: { blink: 4, mouth: 6, head: 2.2, pitch: 2.2 }, // 面捕灵敏度（眨眼/张嘴/左右摆头/上下摆头）
  camPreview: true, // 摄像头预览小窗
  chat: {           // AI 对话（DeepSeek）
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    persona: 'default',   // default / cool / gentle
    historyRounds: 20,    // 记忆轮数
    voice: true,          // 语音朗读
    bubbleTime: 8,        // 气泡显示秒数
    inputDevice: '',      // 音频输入设备（预留）
    outputDevice: '',     // 音频输出设备（可接虚拟声卡/变声器）
    webSearch: true,      // 联网搜索（Bing，免费）
    thinking: false,      // 思考模式：气泡里显示模型思考过程（更耗 token）
    micMode: 'click',     // 语音输入交互：click=点击说话/再点关闭，hold=长按说话松开结束，always=全程监听自动识别发送
    ttsEchoDelay: 0.1,    // 朗读结束后的回声抑制秒数（防麦克风听到自己的朗读声）
    vadThold: 0.75,       // 语音活动检测阈值 0.1~0.95：越大越不容易被噪声误触发，但小声说话可能漏检
    voiceMode: 'piper',   // 语音引擎固定 Piper（CosyVoice2 已移除）
  },
};
const CHAT_PERSONAS = {
  default: '你是重音テト（Kasane Teto），一个活泼可爱的虚拟歌姬。请用简短、口语化、带点俏皮的中文回复，每句话不超过两行，适当使用语气词，偶尔自称"テト"。',
  cool: '你是重音テト，性格高冷寡言。回复极其简短，通常不超过一句话，语气平淡，偶尔毒舌，不要用表情和语气词。',
  gentle: '你是重音テト，温柔治愈的邻家女孩。用温暖、柔和、关怀的语气说话，回复简短，喜欢轻声安慰和鼓励别人。',
};
let config = { ...DEFAULT_CONFIG };

function saveConfig() {
  try { fs.writeFileSync(configFile(), JSON.stringify(config, null, 2)); } catch (e) { log('saveConfig:', e.message); }
}
function loadConfig() {
  try {
    if (fs.existsSync(configFile())) {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
      if (!Array.isArray(config.models)) config.models = [];
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
    }
  } catch (e) { log('loadConfig:', e.message); }
  saveConfig();
}

// ---------- AI 对话历史（100KB 内滑动） ----------
let chatHistory = []; // [{ role, content }]
const CHAT_MAX_BYTES = 100 * 1024;

function chatHistoryFile() {
  return path.join(app.getPath('userData'), 'chat-history.json');
}
function loadChatHistory() {
  try {
    if (fs.existsSync(chatHistoryFile())) {
      chatHistory = JSON.parse(fs.readFileSync(chatHistoryFile(), 'utf8'));
      if (!Array.isArray(chatHistory)) chatHistory = [];
      trimChatHistory();
    }
  } catch (e) { log('loadChatHistory:', e.message); }
}
function saveChatHistory() {
  try { fs.writeFileSync(chatHistoryFile(), JSON.stringify(chatHistory)); } catch (e) {}
}
function chatHistoryBytes() {
  return chatHistory.reduce((s, m) => s + Buffer.byteLength(m.content || '', 'utf8'), 0);
}
// 100KB 滑动：超限时从最旧的消息开始丢弃（保证窗口内总量 ≤ 100KB）
function trimChatHistory() {
  let total = chatHistoryBytes();
  while (total > CHAT_MAX_BYTES && chatHistory.length > 0) {
    const removed = chatHistory.shift();
    total -= Buffer.byteLength(removed.content || '', 'utf8');
  }
}

// ---------- AI 对话完整记录（不受滑动窗口影响；清空对话历史时一并删除） ----------
let chatFull = []; // [{ time, role, content }]
function chatFullFile() {
  return path.join(app.getPath('userData'), 'chat-full.json');
}
function loadChatFull() {
  try {
    if (fs.existsSync(chatFullFile())) {
      chatFull = JSON.parse(fs.readFileSync(chatFullFile(), 'utf8'));
      if (!Array.isArray(chatFull)) chatFull = [];
    }
  } catch (e) { log('loadChatFull:', e.message); }
}
function saveChatFull() {
  try { fs.writeFileSync(chatFullFile(), JSON.stringify(chatFull)); } catch (e) {}
}
function appendChatFull(role, content) {
  chatFull.push({ time: new Date().toISOString(), role, content });
  saveChatFull();
}
function clearChatAll() {
  chatHistory = [];
  saveChatHistory();
  chatFull = [];
  saveChatFull();
  send('chat-history-cleared');
}

// ---------- 模型发现 ----------
function findFiles(root, ext, depth) {
  const out = [];
  const walk = (dir, d) => {
    if (d < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      if (en.name.startsWith('.')) continue;
      const p = path.join(dir, en.name);
      if (en.isDirectory()) walk(p, d - 1);
      else if (en.isFile() && en.name.toLowerCase().endsWith(ext.toLowerCase())) out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

function discoverModels() {
  const found = [];
  const roots = [MODELS_DIR, ...(config.scanDirs || []), ...SEED_MODEL_DIRS];
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    for (const f of findFiles(r, '.model3.json', 3)) {
      const dir = path.dirname(f);
      const name = path.basename(dir);
      found.push({ name, path: dir, rel: path.basename(f) });
    }
  }
  // 与现有配置合并（按 path 去重，保留已存条目）
  const known = new Set(config.models.map(m => m.path.toLowerCase()));
  for (const m of found) {
    if (!known.has(m.path.toLowerCase())) {
      config.models.push(m);
      known.add(m.path.toLowerCase());
    }
  }
  // 清理不存在的条目
  config.models = config.models.filter(m => fs.existsSync(path.join(m.path, m.rel)));
  if (config.current >= config.models.length) config.current = config.models.length - 1;
  saveConfig();
}

// ---------- 模型 payload：注入 Motions / Expressions 并转为绝对 live2d:// URL ----------
const payloadCache = new Map();

function buildModelPayload(m) {
  const key = m.path.toLowerCase();
  if (payloadCache.has(key)) return payloadCache.get(key);
  const payload = { name: m.name, settings: null, expressions: [], motionGroups: [], aspect: null, error: null };
  try {
    const full = path.join(m.path, m.rel);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    raw.url = absModelUrl(m.path, m.rel); // ModelSettings 要求 url 字段；作为相对路径解析基准
    if (!raw.FileReferences) raw.FileReferences = {};
    const fr = raw.FileReferences;
    const abs = p => absModelUrl(m.path, p);

    if (fr.Moc) fr.Moc = abs(fr.Moc);
    if (Array.isArray(fr.Textures)) fr.Textures = fr.Textures.map(abs);
    if (fr.Physics) fr.Physics = abs(fr.Physics);
    if (fr.Pose) fr.Pose = abs(fr.Pose);
    if (fr.DisplayInfo) fr.DisplayInfo = abs(fr.DisplayInfo);

    // 原模型引用里的 Motions 相对路径 → 绝对
    if (fr.Motions && typeof fr.Motions === 'object') {
      for (const g of Object.keys(fr.Motions)) {
        fr.Motions[g] = (fr.Motions[g] || []).map(en => {
          if (typeof en.File === 'string') return { ...en, File: abs(en.File) };
          return en;
        });
      }
    }
    // 缺失 Motions 时扫描 Motions 目录注入（VTS 模型通常不写 FileReferences.Motions）
    if (!fr.Motions || !Object.keys(fr.Motions).length) {
      const files = findFiles(path.join(m.path, 'Motions'), '.motion3.json', 2);
      if (files.length) {
        const g = { Idle: [], Sleep: [], All: [] };
        for (const f of files) {
          const relF = path.relative(m.path, f);
          const name = path.basename(f, '.motion3.json');
          const entry = { File: abs(relF) };
          g.All.push(entry);
          const lower = name.toLowerCase();
          if (lower.includes('idle')) g.Idle.push(entry);
          else if (lower.includes('sleep')) g.Sleep.push(entry);
          else (g[name] || (g[name] = [])).push(entry);
        }
        for (const k of Object.keys(g)) if (!g[k].length) delete g[k];
        fr.Motions = g;
      }
    }
    if (fr.Motions) payload.motionGroups = Object.keys(fr.Motions);

    // 缺失 Expressions 时扫描 Expressions 目录注入
    if (fr.Expressions && Array.isArray(fr.Expressions)) {
      fr.Expressions = fr.Expressions.map(en => (typeof en.File === 'string' ? { ...en, File: abs(en.File) } : en));
    }
    if (!fr.Expressions || !fr.Expressions.length) {
      const exps = findFiles(path.join(m.path, 'Expressions'), '.exp3.json', 2);
      if (exps.length) {
        const list = exps.map(f => {
          const relF = path.relative(m.path, f);
          let nm = path.basename(f, '.exp3.json');
          try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j.Name) nm = String(j.Name);
          } catch {}
          return { File: abs(relF), Name: nm };
        });
        payload.expressions = list.map(e => e.Name);
        fr.Expressions = list.map(e => ({ File: e.File, Name: e.Name }));
      }
    }

    if (raw.Layout && raw.Layout.Width && raw.Layout.Height) {
      payload.aspect = raw.Layout.Width / raw.Layout.Height;
    }
    payload.settings = raw;
  } catch (e) {
    payload.error = e.message;
    log('buildModelPayload error:', m.path, e.message);
  }
  payloadCache.set(key, payload);
  return payload;
}

function currentModel() {
  return config.models[config.current] || null;
}
function currentPayload() {
  const m = currentModel();
  return m ? buildModelPayload(m) : null;
}

// ---------- 窗口 ----------
let win = null;
let tray = null;
let quitting = false;
let interactive = false; // 鼠标当前是否在模型上（决定窗口是否接收鼠标事件）
let resizeMode = false;  // 调整大小模式：显示边框，窗口全程接收鼠标事件
let cameraOn = false;    // 摄像头捕捉状态（与渲染进程同步，用于菜单勾选显示）

function targetSize() {
  const wa = screen.getPrimaryDisplay().workArea;
  const payload = currentPayload();
  const aspect = payload && payload.aspect ? payload.aspect : 0.8;
  const h = clamp(Math.round(wa.height * 0.35 * (config.scale || 1)), 100, wa.height);
  const w = clamp(Math.round(h * aspect), 60, wa.width);
  return { width: w, height: h };
}

function defaultPosition(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - size.width - 40, y: wa.y + wa.height - size.height - 10 };
}

function ensureVisible(pos, size) {
  const displays = screen.getAllDisplays();
  const wa = displays.length ? displays[0].workArea : { x: 0, y: 0, width: 1920, height: 1080 };
  const x = clamp(pos.x, wa.x - size.width + 40, wa.x + wa.width - 40);
  const y = clamp(pos.y, wa.y, wa.y + wa.height - 40);
  return { x, y };
}

function createWindow() {
  const size = targetSize();
  const pos = config.pos || defaultPosition(size);
  const p = ensureVisible(pos, size);
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: p.x,
    y: p.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(config.alwaysOnTop, 'floating');
  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  // 性能优化：失焦自动降帧（省电），聚焦恢复
  const applyFrameRate = () => {
    if (!win || win.isDestroyed()) return;
    const saving = config.powerSave !== false && !win.isFocused();
    try { win.webContents.setFrameRate(saving ? 30 : 60); } catch (e) {}
  };
  win.on('focus', applyFrameRate);
  win.on('blur', applyFrameRate);
  win.webContents.once('did-finish-load', applyFrameRate);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 1) log(`renderer[${level}]`, message, `(${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => log('did-fail-load', code, desc));
  win.once('ready-to-show', () => {
    if (!isSmoke) win.showInactive();
  });
  win.on('move', () => {
    if (!win) return;
    savePosSoon();
  });
  // 全局鼠标位置轮询：鼠标不在窗口内时视线也跟随（发送相对窗口中心的偏移）
  const globalMouseTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      const p = screen.getCursorScreenPoint();
      const [wx, wy] = win.getPosition();
      const [ww, wh] = win.getSize();
      win.webContents.send('global-mouse', {
        x: p.x - (wx + ww / 2),
        y: p.y - (wy + wh / 2),
      });
    } catch (e) {}
  }, 80);
  win.on('closed', () => clearInterval(globalMouseTimer));
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  applyIgnore();
  if (isSmoke) win.show();
}

let posTimer = null;
function savePosSoon() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    if (win) config.pos = win.getPosition();
    saveConfig();
  }, 800);
}

function applyIgnore() {
  if (!win) return;
  if (config.clickThrough) {
    win.setIgnoreMouseEvents(true); // 完全穿透
  } else if (resizeMode) {
    win.setIgnoreMouseEvents(false); // 调整模式下窗口全程接收鼠标事件
  } else {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  }
}

function resizeWindow(anchorBottomCenter = true) {
  if (!win) return;
  const size = targetSize();
  const [x, y] = win.getPosition();
  const [cw, ch] = win.getSize();
  const nx = Math.round(x + (cw - size.width) / 2);
  const ny = Math.round(y + (ch - size.height));
  const p = ensureVisible(anchorBottomCenter ? { x: nx, y: ny } : { x, y }, size);
  win.setBounds({ x: p.x, y: p.y, width: size.width, height: size.height });
  config.pos = p;
  win.webContents.send('resized', { ...size, scale: config.scale });
}

function setScale(v) {
  config.scale = clamp(v, 0.15, 3);
  saveConfig();
  resizeWindow();
}

// ---------- 菜单 ----------
const SIZE_PRESETS = [
  { label: '50%', v: 0.5 },
  { label: '75%', v: 0.75 },
  { label: '100%（默认）', v: 1 },
  { label: '125%', v: 1.25 },
  { label: '150%', v: 1.5 },
  { label: '200%', v: 2 },
];

const SENS_PRESETS = [1, 2, 3, 4, 6, 8, 10];
const SENS_DEFAULTS = { blink: 4, mouth: 6, head: 2.2, pitch: 2.2 };

function sensMenu(key, label) {
  const cur = (config.camSens || {})[key] || SENS_DEFAULTS[key];
  return SENS_PRESETS.map(v => ({
    label: (Math.abs(cur - v) < 0.01 ? '✓ ' : '     ') + label + ' ' + v + 'x',
    click: () => {
      config.camSens = { ...SENS_DEFAULTS, ...(config.camSens || {}), [key]: v };
      saveConfig();
      send('cam-sens-changed', config.camSens);
    },
  }));
}

// AI 对话菜单（除密钥外全部为选项；密钥通过"打开配置文件"填写）
// ---------- 朗读状态（渲染层会发 set-tts-active；全程监听的 VAD 在渲染层做） ----------
let ttsActive = false;   // 桌宠正在朗读
let ttsEndAt = 0;        // 朗读结束时间戳
// 清洗识别幻觉（噪声被脑补成字幕/道谢/音乐标记等）
function cleanHalluc(t) {
  t = String(t || '');
  t = t.replace(/[（(][^（）()]{1,12}[）)]/g, ' ');                      // 括号片段直接删（(音乐)(字幕製作:貝爾) 等）
  t = t.replace(/字幕(製作|制作|由)?[：:]\s*[^\s，。！？!?]{0,16}/g, ' '); // 字幕:J Chong / 字幕製作:貝爾
  t = t.replace(/字幕(製作|制作|由)[^\s，。！？!?]{0,16}/g, ' ');         // 无冒号变体
  t = t.replace(/(^|[\s，。！？!?])字幕(?=$|[\s，。！？!?])/g, ' ');       // 单独出现的"字幕"
  t = t.replace(/subtitles?\s*(by\s*[A-Za-z\s]{0,24})?/gi, ' ');         // Subtitles by XXX
  t = t.replace(/thanks?\s+for\s+watching/gi, ' ');
  t = t.replace(/[♪♫❤♥★☆◆◇●○※◯×·]+/g, '');                            // 装饰性符号
  t = t.replace(/謝謝觀看|谢谢观看|感謝觀看|下次見|下次见|再見|再见|訂閱|订阅|點讚|点赞|關注|关注|按讚|按赞/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fff\u3040-\u30ffA-Za-z]/.test(t)) return ''; // 中日文/英文均可（纯符号丢弃）
  // 剩余若只是无意义单字/叠词组合 → 丢弃
  if (/^(音乐|音樂|音乐声|音樂聲|贝|貝|尔|爾|啊|嗯|哦|喔|呃)+$/.test(t.replace(/[，。！？!?、\s]/g, ''))) return '';
  return t;
}

// ---------- 全程监听：本地连续采集 + 能量 VAD（渲染层） ----------
function chatMenuTemplate() {
  const cfg = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
  const radio = (items, key) => items.map(o => ({
    label: (cfg[key] === o.v ? '✓ ' : '     ') + o.label,
    click: () => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), [key]: o.v };
      saveConfig();
      chatChanged();
    },
  }));
  const chatChanged = () => {
    send('chat-config-changed', { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) });
  };
  return [
    { label: '开启对话', type: 'checkbox', checked: !!cfg.enabled, click: mi => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), enabled: mi.checked };
      saveConfig(); chatChanged();
    }},
    { label: 'AI 对话设置…', click: () => createChatConfigWindow() },
    { label: '重新加载配置', click: () => {
      loadConfig(); loadChatHistory(); loadChatFull(); chatChanged();
    }},
    { type: 'separator' },
    { label: '模型', submenu: radio([{ label: 'deepseek-v4-flash（快速）', v: 'deepseek-v4-flash' }, { label: 'deepseek-v4-pro（高质量）', v: 'deepseek-v4-pro' }], 'model') },
    { label: '人设', submenu: radio([{ label: '活泼（默认）', v: 'default' }, { label: '高冷', v: 'cool' }, { label: '温柔', v: 'gentle' }], 'persona') },
    { label: '记忆轮数', submenu: radio([{ label: '10 轮', v: 10 }, { label: '20 轮', v: 20 }, { label: '30 轮', v: 30 }, { label: '50 轮', v: 50 }], 'historyRounds') },
    { label: '气泡时长', submenu: radio([{ label: '5 秒', v: 5 }, { label: '8 秒', v: 8 }, { label: '12 秒', v: 12 }], 'bubbleTime') },
    { label: '语音朗读', type: 'checkbox', checked: cfg.voice !== false, click: mi => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), voice: mi.checked };
      saveConfig(); chatChanged();
    }},
    { label: '思考模式（气泡显示思考过程，更耗 token）', type: 'checkbox', checked: cfg.thinking === true, click: mi => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), thinking: mi.checked };
      saveConfig(); chatChanged();
    }},
    { label: '联网搜索', type: 'checkbox', checked: cfg.webSearch !== false, click: mi => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), webSearch: mi.checked };
      saveConfig(); chatChanged();
    }},
    { label: '麦克风模式', submenu: radio([{ label: '点击说话 / 再点关闭', v: 'click' }, { label: '长按说话 / 松开结束', v: 'hold' }, { label: '全程监听（自动识别发送）', v: 'always' }], 'micMode') },
    { label: '朗读回声抑制', submenu: radio([{ label: '0.1 秒', v: 0.1 }, { label: '0.5 秒', v: 0.5 }, { label: '1 秒', v: 1 }, { label: '2 秒', v: 2 }, { label: '4 秒', v: 4 }, { label: '6 秒', v: 6 }, { label: '8 秒（变声器大延迟）', v: 8 }], 'ttsEchoDelay') },
    { label: '语音识别灵敏度（VAD 阈值）', submenu: radio([{ label: '宽松 0.5（小声也能触发，噪声易误报）', v: 0.5 }, { label: '默认 0.75', v: 0.75 }, { label: '严格 0.9（只认大声，最防风扇）', v: 0.9 }], 'vadThold') },
    { type: 'separator' },
    { label: '查看历史对话…', click: () => createChatHistoryWindow() },
    { label: '选择气泡背景图…', click: () => {
      dialog.showOpenDialog(win, {
        title: '选择气泡背景图片',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        properties: ['openFile'],
      }).then(r => {
        if (r.canceled || !r.filePaths.length) return;
        try {
          const src = r.filePaths[0];
          const dst = path.join(app.getPath('userData'), 'chat-bg' + path.extname(src).toLowerCase());
          fs.copyFileSync(src, dst);
          config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), bgImage: dst };
          saveConfig(); chatChanged();
        } catch (e) { log('chat bg copy failed:', e.message); }
      });
    }},
    { label: '清除气泡背景', click: () => {
      config.chat = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), bgImage: '' };
      saveConfig(); chatChanged();
    }},
    { label: '清空对话历史（' + (chatHistoryBytes() / 1024).toFixed(1) + ' KB；完整记录一并删除）', click: () => {
      clearChatAll();
    }},
  ];
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function switchModel(i) {
  if (i < 0 || i >= config.models.length) return;
  config.current = i;
  saveConfig();
  const m = currentModel();
  log('switch model:', m && m.name);
  send('model-changed', currentPayload());
  resizeWindow();
  if (tray) tray.setToolTip('Live2D 桌宠 - ' + (m ? m.name : ''));
}

function addModelDialog() {
  dialog.showOpenDialog(win, {
    title: '选择 Live2D 模型文件 (model3.json)',
    filters: [{ name: 'Live2D 模型 (model3.json)', extensions: ['json'] }],
    properties: ['openFile'],
  }).then(r => {
    if (r.canceled || !r.filePaths.length) return;
    const f = r.filePaths[0];
    if (!/model3\.json$/i.test(path.basename(f))) {
      dialog.showMessageBox(win, { type: 'warning', message: '请选择 .model3.json 文件' });
      return;
    }
    const dir = path.dirname(f);
    const dup = config.models.find(m => m.path.toLowerCase() === dir.toLowerCase());
    if (dup) {
      switchModel(config.models.indexOf(dup));
      return;
    }
    config.models.push({ name: path.basename(dir), path: dir, rel: path.basename(f) });
    config.current = config.models.length - 1;
    saveConfig();
    switchModel(config.current);
  });
}

function openModelsFolder() {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  shell.openPath(MODELS_DIR);
}

function refreshModels() {
  discoverModels();
  payloadCache.clear();
  if (!config.models.length) {
    dialog.showMessageBox(win, { type: 'info', message: '未找到模型。\n请将模型文件夹放入 models 目录，或使用「添加模型…」选择 model3.json。' });
  }
}

function buildMenu(template) {
  return Menu.buildFromTemplate(template);
}

function modelMenuTemplate() {
  const items = config.models.map((m, i) => ({
    label: (i === config.current ? '✓ ' : '    ') + m.name,
    click: () => switchModel(i),
  }));
  if (!items.length) items.push({ label: '（暂无模型）', enabled: false });
  items.push(
    { type: 'separator' },
    { label: '添加模型…', click: addModelDialog },
    { label: '打开模型文件夹', click: openModelsFolder },
    { label: '刷新模型列表', click: refreshModels }
  );
  return items;
}

function expressionMenuTemplate() {
  const payload = currentPayload();
  const items = [];
  if (payload && payload.expressions.length) {
    items.push({ label: '随机表情', click: () => send('set-expression', '') });
    items.push({ label: '恢复默认表情', click: () => send('set-expression', null) });
    items.push({ type: 'separator' });
    const forms = payload.expressions.slice(-4); // 后四个归"形态"，不在此列出
    for (const name of payload.expressions) {
      if (forms.includes(name)) continue;
      items.push({ label: name, click: () => send('set-expression', name) });
    }
    items.push({ type: 'separator' });
    items.push({ label: '测试表情（最大强度，3 秒后自动恢复）', click: () => send('test-expression') });
  } else {
    items.push({ label: '（此模型没有表情）', enabled: false });
  }
  return items;
}

// 形态：表情列表最后四个，单选切换（持续生效直到换回默认）
function setForm(name) {
  config.formExpression = name || '';
  saveConfig();
  send('set-form', config.formExpression);
}
function formMenuTemplate() {
  const payload = currentPayload();
  const items = [];
  if (payload && payload.expressions.length) {
    const forms = payload.expressions.slice(-4);
    items.push({
      label: (config.formExpression ? '     ' : '✓ ') + '默认（不选形态）',
      click: () => setForm(''),
    });
    for (const name of forms) {
      items.push({
        label: (config.formExpression === name ? '✓ ' : '     ') + name,
        click: () => setForm(name),
      });
    }
  } else {
    items.push({ label: '（此模型没有表情）', enabled: false });
  }
  return items;
}

function contextMenuTemplate() {
  return [
    { label: '模型', submenu: modelMenuTemplate() },
    { label: '表情', submenu: expressionMenuTemplate() },
    { label: '形态', submenu: formMenuTemplate() },
    { label: '动作', submenu: [
      { label: '随机动作', click: () => send('play-motion', 'random') },
      { label: '睡觉 / 叫醒', click: () => send('toggle-sleep') },
    ]},
    { label: '摄像头捕捉（面部表情映射 + 右下角预览）', type: 'checkbox', checked: !!cameraOn, click: () => {
      send('toggle-camera');
    }},
    { label: '摄像头预览小窗', type: 'checkbox', checked: config.camPreview !== false, click: mi => {
      config.camPreview = mi.checked; saveConfig();
      send('cam-preview-changed', config.camPreview !== false);
    }},
    { label: '面捕灵敏度', submenu: [
      { label: '眨眼灵敏度', submenu: sensMenu('blink', '眨眼') },
      { label: '张嘴灵敏度', submenu: sensMenu('mouth', '张嘴') },
      { label: '左右摆头灵敏度', submenu: sensMenu('head', '左右摆头') },
      { label: '上下摆头灵敏度', submenu: sensMenu('pitch', '上下摆头') },
    ]},
    { label: 'AI 对话', submenu: chatMenuTemplate() },
    { label: '大小', submenu: [
      { label: '放大 (+)', click: () => setScale(config.scale + 0.1) },
      { label: '缩小 (-)', click: () => setScale(config.scale - 0.1) },
      { type: 'separator' },
      ...SIZE_PRESETS.map(p => ({ label: p.label, click: () => setScale(p.v) })),
      { label: '恢复默认大小', click: () => setScale(1) },
    ]},
    { label: '调整大小（边框，双击宠物也可切换）', click: () => send('toggle-resize-mode') },
    { type: 'separator' },
    { label: '置顶显示', type: 'checkbox', checked: !!config.alwaysOnTop, click: mi => {
      config.alwaysOnTop = mi.checked; saveConfig();
      if (win) win.setAlwaysOnTop(config.alwaysOnTop, 'floating');
    }},
    { label: '高清渲染（2x 超采样，异常时可关闭）', type: 'checkbox', checked: config.quality !== 'compat', click: mi => {
      config.quality = mi.checked ? 'high' : 'compat';
      saveConfig();
      resizeMode = false;
      interactive = false;
      applyIgnore();
      if (win && !win.isDestroyed()) win.webContents.reload();
    }},
    { label: '鼠标穿透（穿透时用托盘菜单操作）', type: 'checkbox', checked: !!config.clickThrough, click: mi => {
      config.clickThrough = mi.checked; saveConfig(); applyIgnore();
    }},
    { label: '省电模式（失焦降帧）', type: 'checkbox', checked: config.powerSave !== false, click: mi => {
      config.powerSave = mi.checked; saveConfig();
      if (win && !win.isDestroyed()) {
        const saving = config.powerSave !== false && !win.isFocused();
        try { win.webContents.setFrameRate(saving ? 30 : 60); } catch (e) {}
      }
    }},
    { label: '回到默认位置（右下角）', click: () => {
      const size = targetSize();
      const p = defaultPosition(size);
      config.pos = p; saveConfig();
      if (win) { win.setBounds({ x: p.x, y: p.y, width: size.width, height: size.height }); }
    }},
    { type: 'separator' },
    { label: '隐藏到托盘', click: () => win && win.hide() },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ];
}

let contextMenu = null;
function popupContextMenu() {
  contextMenu = buildMenu(contextMenuTemplate());
  contextMenu.popup({ window: win });
}

// AI 对话设置窗口
let chatConfigWin = null;
function createChatConfigWindow() {
  if (chatConfigWin && !chatConfigWin.isDestroyed()) {
    chatConfigWin.show();
    chatConfigWin.focus();
    return;
  }
  chatConfigWin = new BrowserWindow({
    width: 460,
    height: 620,
    resizable: false,
    title: 'AI 对话设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatConfigWin.loadFile(path.join(APP_DIR, 'renderer', 'config.html'));
  chatConfigWin.on('closed', () => { chatConfigWin = null; });
}

// 历史对话查看窗口（完整记录，不受滑动窗口影响）
let chatHistoryWin = null;
function createChatHistoryWindow() {
  if (chatHistoryWin && !chatHistoryWin.isDestroyed()) {
    chatHistoryWin.show();
    chatHistoryWin.focus();
    return;
  }
  chatHistoryWin = new BrowserWindow({
    width: 760,
    height: 640,
    title: '历史对话（完整记录）',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatHistoryWin.loadFile(path.join(APP_DIR, 'renderer', 'chat-history.html'));
  chatHistoryWin.on('closed', () => { chatHistoryWin = null; });
}

function trayMenuTemplate() {
  return [
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { label: '随机动作', click: () => send('play-motion', 'random') },
    { label: '睡觉 / 叫醒', click: () => send('toggle-sleep') },
    { type: 'separator' },
    { label: '鼠标穿透（穿透时用本菜单恢复）', type: 'checkbox', checked: !!config.clickThrough, click: mi => {
      config.clickThrough = mi.checked; saveConfig(); applyIgnore();
    }},
    { label: '模型', submenu: modelMenuTemplate() },
    { label: '大小', submenu: [
      ...SIZE_PRESETS.map(p => ({ label: p.label, click: () => setScale(p.v) })),
      { label: '恢复默认大小', click: () => setScale(1) },
    ]},
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ];
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { win.showInactive(); applyIgnore(); }
}

function createTray() {
  const icon = path.join(APP_DIR, 'assets', 'tray.png');
  tray = new Tray(icon);
  tray.setToolTip('Live2D 桌宠 - ' + (currentModel() ? currentModel().name : ''));
  tray.setContextMenu(buildMenu(trayMenuTemplate()));
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.showInactive(); applyIgnore(); }
  });
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('get-state', () => {
    const payload = currentPayload();
    return {
      size: targetSize(),
      scale: config.scale,
      model: payload,
      modelName: currentModel() ? currentModel().name : '',
      alwaysOnTop: config.alwaysOnTop,
      clickThrough: config.clickThrough,
      quality: config.quality,
      smoke: isSmoke,
      diag: isDiag,
      camSens: { blink: 4, mouth: 6, head: 2.2, pitch: 2.2, ...(config.camSens || {}) },
      camPreview: config.camPreview !== false,
      formExpression: config.formExpression || '',
      chat: (() => {
        const c = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
        if (c.bgImage && fs.existsSync(c.bgImage)) {
          c.bgImage = 'file:///' + c.bgImage.replace(/\\/g, '/');
        } else {
          c.bgImage = '';
        }
        return c;
      })(),
    };
  });
  ipcMain.on('set-interactive', (_e, v) => {
    if (config.clickThrough) return;
    const b = !!v;
    if (b !== interactive) {
      interactive = b;
      applyIgnore();
    }
  });
  ipcMain.on('drag-window', (_e, dx, dy) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const wa = screen.getPrimaryDisplay().workArea;
    // 防止拖出屏幕（至少保留一部分可见）
    const nx = clamp(x + Math.round(dx), wa.x - w + 60, wa.x + wa.width - 60);
    const ny = clamp(y + Math.round(dy), wa.y, wa.y + wa.height - 60);
    win.setPosition(nx, ny);
    savePosSoon();
  });
  ipcMain.on('adjust-scale', (_e, d) => {
    setScale((config.scale || 1) + Number(d) || 0.08);
  });
  ipcMain.on('set-scale', (_e, v) => {
    setScale(Number(v) || 1);
  });
  ipcMain.on('set-resize-mode', (_e, v) => {
    resizeMode = !!v;
    if (resizeMode && win) {
      try { win.show(); win.focus(); } catch (e) {} // 调整模式需要焦点，才能感知"点击别处"失焦
    }
    applyIgnore();
  });
  ipcMain.on('set-calibrating', (_e, v) => {
    // 校准期间窗口全透明（渲染照常进行），完成后恢复，避免用户看到校准跳动
    if (win && !win.isDestroyed()) {
      try { win.setOpacity(v ? 0 : 1); } catch (e) {}
    }
  });
  ipcMain.on('camera-state', (_e, v) => {
    cameraOn = !!v;
  });
  // Bing 联网搜索（免费、国内直连）：抓结果列表 + 打开第 1 条结果页取正文
  const https = require('https');
  const http = require('http');
  function webGet(u, redirects = 3) {
    return new Promise((resolve, reject) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        timeout: 12000,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(webGet(new URL(res.headers.location, u).toString(), redirects - 1));
        }
        let b = '';
        res.on('data', d => { b += d; if (b.length > 800000) req.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          resolve(b);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    });
  }
  function stripHtml(html) {
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch (e) { return ' '; } })
      .replace(/\s+/g, ' ').trim();
  }
  async function bingSearch(q) {
    const html = await webGet('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&mkt=zh-CN&setlang=zh-hans');
    const items = [];
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/g;
    let m;
    while ((m = re.exec(html)) && items.length < 5) {
      const title = stripHtml(m[2]);
      if (title) items.push({ title, url: m[1] });
    }
    if (!items.length) return '';
    let out = '搜索结果：\n' + items.map((it, i) => (i + 1) + '. ' + it.title + '（' + it.url + '）').join('\n');
    try { // 打开结果页取正文（正文质量远高于搜索摘要）；第 1 条正文太短就试第 2 条
      let txt = '';
      for (const it of items.slice(0, 2)) {
        try { txt = stripHtml(await webGet(it.url, 3)); } catch (e) { txt = ''; }
        if (txt.length > 200) break;
      }
      if (txt.length > 200) out += '\n\n结果页面正文（节选）：\n' + txt.slice(300, 1800);
    } catch (e) { log('bing page fetch:', e && e.message); }
    return out;
  }
  ipcMain.handle('chat-send', async (_e, text) => {
    const cfg = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
    if (!cfg.enabled) return { ok: false, error: '对话未开启（右键 → AI 对话 → 开启对话）' };
    if (!cfg.apiKey) return { ok: false, error: '未配置 API Key（右键 → AI 对话 → 打开配置文件填 apiKey）' };
    try {
      chatHistory.push({ role: 'user', content: String(text).slice(0, 2000) });
      appendChatFull('user', String(text).slice(0, 2000));
      const thinkingOn = cfg.thinking === true;
      const d = new Date();
      const nowStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const rule = thinkingOn
        ? '（规则：可以输出思考过程，但思考写完后必须单独一行写【回答】标记，标记之后才是你要对用户说的最终回复。）'
        : '（规则：绝对不要输出任何思考、分析或推理过程，直接给出最终回复；回复第一行单独写【回答】，从第二行开始才是你要对用户说的话。）';
      const system = (CHAT_PERSONAS[cfg.persona] || CHAT_PERSONAS.default)
        + `\n（现在的时间是${nowStr}。被问到日期或时间时，直接按这个时间如实回答。）` + '\n' + rule
        + '\n（用户用什么语言说话，你就用什么语言回答，包括日语和英语；用户混说时，你也可以混说。）';
      const rounds = Math.max(1, cfg.historyRounds || 20);
      const messages = [{ role: 'system', content: system }, ...chatHistory.slice(-rounds * 2)];
      const url = (cfg.baseUrl || 'https://api.deepseek.com') + '/v1/chat/completions';
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey };
      async function callOnce(msgs, withTools) {
        const body = { model: cfg.model || 'deepseek-v4-flash', messages: msgs, max_tokens: thinkingOn ? 3000 : 1200, temperature: 1.0 };
        if (withTools) {
          body.tools = [{
            type: 'function',
            function: {
              name: 'web_search',
              description: '当回答需要实时或最新信息时调用（例如当前日期时间、天气、新闻、股价等）；纯闲聊、凭常识能回答的问题不要调用',
              parameters: { type: 'object', properties: { query: { type: 'string', description: '精简后的搜索关键词' } }, required: ['query'] },
            },
          }];
          body.tool_choice = 'auto';
        }
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error && data.error.message ? data.error.message : ('HTTP ' + res.status));
        }
        return data;
      }
      // 第一轮：模型自己决定要不要联网搜索（function calling）
      const webOn = cfg.webSearch !== false;
      let data;
      try {
        data = await callOnce(messages, webOn);
      } catch (e) {
        if (!webOn) throw e;
        log('带工具调用失败，降级为普通调用:', e && e.message);
        data = await callOnce(messages, false);
      }
      let choice = (data.choices && data.choices[0]) || {};
      let msg = choice.message || {};
      // 模型要求搜索 → 执行并回传，第二轮生成最终回答
      if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        messages.push(msg);
        const t = msg.tool_calls[0];
        let q = '';
        try { q = String((JSON.parse(t.function && t.function.arguments || '{}').query) || '').slice(0, 100); } catch (e) {}
        if (!q) q = String(text).slice(0, 100);
        let sr = '';
        try { sr = await bingSearch(q); } catch (e) { log('bing search:', e && e.message); }
        messages.push({ role: 'tool', tool_call_id: t.id, content: sr ? sr.slice(0, 2200) : '（搜索无结果）' });
        data = await callOnce(messages, false);
        choice = (data.choices && data.choices[0]) || {};
        msg = choice.message || {};
      }
      let reply = String(msg.content || '').trim();
      if (!reply) {
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
          log('chat 只返回思考过程，finish_reason=' + choice.finish_reason);
          throw new Error('模型只返回了思考过程，没有最终回答（请再问一次）');
        }
        log('chat 空回复，原始返回:', JSON.stringify(data).slice(0, 600));
        throw new Error('空回复' + (choice.finish_reason ? '（finish_reason=' + choice.finish_reason + '）' : ''));
      }
      const mAns = reply.match(/【回答】\s*([\s\S]*)$/); // 只取标记后的最终回答
      let thinking = '';
      if (mAns) {
        thinking = reply.slice(0, mAns.index).trim();
        reply = mAns[1].trim();
      }
      if (!reply) throw new Error('空回复');
      chatHistory.push({ role: 'assistant', content: reply });
      appendChatFull('assistant', reply);
      trimChatHistory();
      saveChatHistory();
      return { ok: true, reply, thinking: thinkingOn ? thinking.slice(0, 4000) : '' };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
  ipcMain.handle('chat-state', () => {
    return { ...DEFAULT_CONFIG.chat, ...(config.chat || {}), historyBytes: chatHistoryBytes() };
  });
  ipcMain.handle('chat-get-config', () => {
    return { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
  });
  ipcMain.handle('chat-get-history', () => {
    return chatFull.slice();
  });
  ipcMain.handle('chat-clear-history', () => {
    clearChatAll();
    return { ok: true };
  });
  // 本地语音识别：sherpa-onnx SenseVoice（首选，0.1 秒级）；whisper.cpp 兜底
  ipcMain.handle('voice-stt-ready', () => {
    try {
      if (fs.existsSync(SHERPA_ASR_EXE) && fs.existsSync(SHERPA_MODEL) && fs.existsSync(SHERPA_TOKENS)) return true;
      return fs.existsSync(WHISPER_EXE) && fs.existsSync(WHISPER_MODEL);
    } catch (e) { return false; }
  });
  // 桌宠朗读状态（渲染层全程监听据此暂停收音，防喇叭回声回环）
  ipcMain.on('set-tts-active', (_e, v) => {
    ttsActive = !!v;
    if (!v) ttsEndAt = Date.now();
  });
  // 单段音频 → 文本
  ipcMain.handle('voice-stt', async (_e, buf) => {
    try {
      const bytes = buf && (buf.byteLength !== undefined ? buf.byteLength : buf.length) || 0;
      log('voice-stt 收到音频', bytes, '字节 ≈', (bytes / 32000).toFixed(1), '秒');
      const wavFile = path.join(app.getPath('userData'), 'mic-' + Date.now() + '.wav');
      fs.writeFileSync(wavFile, Buffer.from(buf));
      const t0 = Date.now();
      let text = '';
      let diag = '';
      if (fs.existsSync(SHERPA_ASR_EXE) && fs.existsSync(SHERPA_MODEL) && fs.existsSync(SHERPA_TOKENS)) {
        let outAll = '';
        let errOut = '';
        await new Promise((resolve, reject) => {
          const p = require('child_process').spawn(SHERPA_ASR_EXE, [
            '--sense-voice-model=' + SHERPA_MODEL,
            '--tokens=' + SHERPA_TOKENS,
            '--silero-vad-model=' + SHERPA_VAD,
            '--sense-voice-use-itn=true',
            '--num-threads=4',
            wavFile,
          ], { windowsHide: true });
          p.stdout.setEncoding('utf8');
          p.stdout.on('data', d => { outAll += d; });
          p.stderr.setEncoding('utf8');
          p.stderr.on('data', d => { errOut += String(d); });
          p.on('error', reject);
          p.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error('sherpa exit ' + code + ' ' + errOut.slice(0, 300)));
          });
        });
        diag = 'sherpa stdout=' + JSON.stringify(outAll.slice(0, 300)) + ' stderr=' + errOut.replace(/\s+/g, ' ').slice(-150);
        // 输出行格式：0.038 -- 3.264: 今天天气真不错。（Windows 下是 \r\n 行尾）
        text = outAll.split(/\r?\n/).map(l => {
          const m = l.match(/^\s*[\d.]+\s+--\s+[\d.]+:\s*(.+)$/);
          return m ? m[1].trim() : '';
        }).filter(Boolean).join('');
        text = tw2cn(cleanHalluc(text));
        if (!text) { // 交叉验证：sherpa 空 → 用 whisper 再试一次，若也空说明音频本身没有语音
          try {
            if (fs.existsSync(WHISPER_EXE) && fs.existsSync(WHISPER_MODEL)) {
              const outBase = wavFile.replace(/\.wav$/, '');
              await new Promise((resolve2, reject2) => {
                const p2 = require('child_process').spawn(WHISPER_EXE,
                  ['-m', WHISPER_MODEL, '-f', wavFile, '-l', 'zh', '-otxt', '-of', outBase],
                  { windowsHide: true });
                p2.on('error', reject2);
                p2.on('close', code2 => {
                  if (code2 === 0 && fs.existsSync(outBase + '.txt')) resolve2();
                  else reject2(new Error('whisper exit ' + code2));
                });
              });
              const wt = fs.readFileSync(outBase + '.txt', 'utf8');
              diag += ' | whisper 交叉=' + JSON.stringify(wt.slice(0, 100));
              try { fs.unlinkSync(outBase + '.txt'); } catch (e) {}
            }
          } catch (e2) { diag += ' | whisper 交叉失败: ' + e2.message; }
        }
      } else if (fs.existsSync(WHISPER_EXE) && fs.existsSync(WHISPER_MODEL)) {
        const outBase = wavFile.replace(/\.wav$/, '');
        let errOut = '';
        await new Promise((resolve, reject) => {
          const p = require('child_process').spawn(WHISPER_EXE,
            ['-m', WHISPER_MODEL, '-f', wavFile, '-l', 'zh', '-otxt', '-of', outBase],
            { windowsHide: true });
          p.stderr.on('data', d => { errOut += String(d); });
          p.on('error', reject);
          p.on('close', code => {
            if (code === 0 && fs.existsSync(outBase + '.txt')) resolve();
            else reject(new Error('whisper exit ' + code + ' ' + errOut.slice(0, 300)));
          });
        });
        text = fs.readFileSync(outBase + '.txt', 'utf8');
        text = text.split('\n').map(l => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean).join('');
        text = tw2cn(cleanHalluc(text));
        try { fs.unlinkSync(outBase + '.txt'); } catch (e) {}
      } else {
        return { ok: false, error: '语音识别引擎未安装（vendor/sherpa 或 vendor/whisper）' };
      }
      log('voice-stt 识别耗时', ((Date.now() - t0) / 1000).toFixed(2), '秒 | 结果:', JSON.stringify(text), '|', diag);
      if (text) {
        try { fs.unlinkSync(wavFile); } catch (e) {}
      } else {
        log('voice-stt 空结果，音频保留:', wavFile);
      }
      return { ok: true, text };
    } catch (e) {
      log('voice-stt 失败:', e && e.message);
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
  // Piper TTS：文本 → WAV 文件（中日英三段：假名→日语声线，拉丁字母/数字→英语声线，其余→中文声线，混说分段合成拼接）
  const PUNCT_RE = /[\s，。！？、；：""''（）《》…—,.!?;:()[\]"']/;
  function splitLangSegments(text) {
    const segs = [];
    let cur = '';
    let curKind = null; // 'ja' | 'en' | 'zh'
    for (const ch of [...String(text)]) {
      const isJa = /[\u3040-\u30ff]/.test(ch);
      const isEn = /[A-Za-z0-9]/.test(ch);
      const isPunct = PUNCT_RE.test(ch);
      const kind = isPunct ? null : (isJa ? 'ja' : (isEn ? 'en' : 'zh'));
      if (!cur) { cur = ch; curKind = kind; continue; }
      if (kind === null || kind === curKind) { cur += ch; }
      else { segs.push({ t: cur, kind: curKind }); cur = ch; curKind = kind; }
    }
    if (cur) segs.push({ t: cur, kind: curKind });
    return segs;
  }
  function readWavPcm(file) {
    const b = fs.readFileSync(file);
    let fmt = null, dataStart = 0, dataSize = 0, off = 12;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'fmt ') fmt = { rate: b.readUInt32LE(off + 12), ch: b.readUInt16LE(off + 10), bits: b.readUInt16LE(off + 22) };
      if (id === 'data') { dataStart = off + 8; dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
    if (!fmt || fmt.bits !== 16) throw new Error('bad wav: ' + file);
    const n = Math.floor(dataSize / 2);
    const arr = new Int16Array(n);
    for (let i = 0; i < n; i++) arr[i] = b.readInt16LE(dataStart + i * 2);
    return { rate: fmt.rate, ch: fmt.ch, arr };
  }
  function resamplePcm(arr, from, to) {
    if (from === to) return arr;
    const outLen = Math.max(1, Math.round(arr.length * to / from));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = i * from / to;
      const s0 = Math.floor(s);
      const s1 = Math.min(arr.length - 1, s0 + 1);
      const v = arr[s0] * (1 - (s - s0)) + arr[s1] * (s - s0);
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    return out;
  }
  function writeWav22050(pcm) {
    const buf = Buffer.alloc(44 + pcm.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(22050, 24); buf.writeUInt32LE(44100, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
    Buffer.from(pcm.buffer).copy(buf, 44);
    return buf;
  }
  function runPiper(exe, model, text, outFile) {
    return new Promise((resolve, reject) => {
      const p = require('child_process').spawn(exe,
        ['--model', model, '--output_file', outFile],
        { windowsHide: true });
      let errOut = '';
      p.stderr.on('data', d => { errOut += String(d); });
      p.on('error', reject);
      p.on('close', code => {
        if (code === 0 && fs.existsSync(outFile)) resolve();
        else reject(new Error('piper exit ' + code + ' ' + errOut.slice(0, 200)));
      });
      p.stdin.write(String(text) + '\n');
      p.stdin.end();
    });
  }
  ipcMain.handle('chat-tts', async (_e, text) => {
    try {
      const piperDir = path.join(APP_DIR, 'vendor', 'piper');
      const exe = path.join(piperDir, 'piper', 'piper.exe');
      const zhModel = path.join(piperDir, 'zh_CN-huayan-medium.onnx');
      const jaModel = path.join(piperDir, 'ja_JA-hi_fi_captain-medium.onnx');
      const enModel = path.join(piperDir, 'en_US-lessac-medium.onnx');
      const segs = splitLangSegments(text);
      const kinds = new Set(segs.filter(s => s.kind).map(s => s.kind));
      if (!fs.existsSync(exe)) return { ok: false, error: 'Piper 未安装（vendor/piper）' };
      const outFile = path.join(app.getPath('userData'), 'tts-' + Date.now() + '.wav');
      const modelFor = kind => kind === 'ja' ? jaModel : (kind === 'en' ? enModel : zhModel);
      if (kinds.size > 1) {
        // 多语混说：分段各自合成 → 统一 22050Hz 拼接（段间 0.1 秒停顿）
        for (const k of kinds) {
          if (!fs.existsSync(modelFor(k))) {
            const name = k === 'ja' ? '日语' : (k === 'en' ? '英语' : '中文');
            return { ok: false, error: name + '语音模型缺失（vendor/piper）' };
          }
        }
        const parts = [];
        for (const seg of segs) {
          if (!seg.t.trim()) continue;
          const tmp = path.join(app.getPath('userData'), 'tts-seg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
          await runPiper(exe, modelFor(seg.kind), seg.t, tmp);
          const { rate, arr } = readWavPcm(tmp);
          const pcm = resamplePcm(arr, rate, 22050);
          parts.push(pcm);
          parts.push(new Int16Array(Math.round(22050 * 0.1))); // 停顿
          try { fs.unlinkSync(tmp); } catch (e) {}
        }
        let total = 0;
        for (const p of parts) total += p.length;
        const merged = new Int16Array(total);
        let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        fs.writeFileSync(outFile, writeWav22050(merged));
        return { ok: true, url: 'file:///' + outFile.replace(/\\/g, '/') };
      }
      // 单一语言：单模型直出
      const kind = kinds.values().next().value || 'zh';
      const model = modelFor(kind);
      if (!fs.existsSync(model)) {
        const name = kind === 'ja' ? '日语' : (kind === 'en' ? '英语' : '中文');
        return { ok: false, error: name + '语音模型缺失（vendor/piper）' };
      }
      await runPiper(exe, model, text, outFile);
      return { ok: true, url: 'file:///' + outFile.replace(/\\/g, '/') };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  });
  ipcMain.handle('chat-save-config', (_e, cfg) => {
    try {
      const clean = { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) };
      if (typeof cfg.apiKey === 'string') clean.apiKey = cfg.apiKey.trim();
      if (['deepseek-v4-flash', 'deepseek-v4-pro'].includes(cfg.model)) clean.model = cfg.model;
      if (['default', 'cool', 'gentle'].includes(cfg.persona)) clean.persona = cfg.persona;
      if ([10, 20, 30, 50].includes(Number(cfg.historyRounds))) clean.historyRounds = Number(cfg.historyRounds);
      if ([5, 8, 12].includes(Number(cfg.bubbleTime))) clean.bubbleTime = Number(cfg.bubbleTime);
      if (typeof cfg.voice === 'boolean') clean.voice = cfg.voice;
      if (typeof cfg.inputDevice === 'string') clean.inputDevice = cfg.inputDevice;
      if (typeof cfg.outputDevice === 'string') clean.outputDevice = cfg.outputDevice;
      if (typeof cfg.webSearch === 'boolean') clean.webSearch = cfg.webSearch;
      if (typeof cfg.thinking === 'boolean') clean.thinking = cfg.thinking;
      if (['click', 'hold', 'always'].includes(cfg.micMode)) clean.micMode = cfg.micMode;
      const d = Number(cfg.ttsEchoDelay);
      if (isFinite(d) && d >= 0 && d <= 10) clean.ttsEchoDelay = Math.round(d * 10) / 10;
      const vth = Number(cfg.vadThold);
      if (isFinite(vth) && vth >= 0.1 && vth <= 0.95) clean.vadThold = Math.round(vth * 100) / 100;
      delete clean.jinaKey; // 已弃用 Jina
      config.chat = clean;
      saveConfig();
      send('chat-config-changed', { ...DEFAULT_CONFIG.chat, ...(config.chat || {}) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message };
    }
  });
  ipcMain.on('chat-clear-history', () => {
    chatHistory = [];
    saveChatHistory();
  });
  ipcMain.on('report-aspect', (_e, a) => {
    const payload = currentPayload();
    const aspect = clamp(Number(a) || 1, 0.1, 5);
    if (payload && !payload.aspect) {
      payload.aspect = aspect;
      resizeWindow();
    }
  });
  ipcMain.on('show-context-menu', popupContextMenu);
  ipcMain.on('smoke-result', async (_e, ok, msg) => {
    if (!isSmoke) return;
    try {
      let shot = '';
      if (win && ok) {
        await new Promise(r => setTimeout(r, 600));
        const img = await win.capturePage();
        const png = img.toPNG();
        fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.png'), png);
        shot = path.join(app.getPath('userData'), 'smoke.png');
      }
      fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.txt'),
        `OK=${ok}\nMSG=${msg}\nSHOT=${shot}\n`);
      log('smoke result:', ok, msg);
    } catch (e) {
      log('smoke write error:', e.message);
    }
    app.exit(ok ? 0 : 1);
  });
}

// ---------- 生命周期 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.showInactive(); applyIgnore(); }
  });

  app.whenReady().then(() => {
    loadConfig();
    loadChatHistory();
    loadChatFull();
    discoverModels();
    registerModelProtocol();
    setupIpc();
    createWindow();
    createTray();
    app.setAppUserModelId('live2d-desktop-pet');

    // 摄像头/麦克风权限：允许媒体设备（面部捕捉、语音输入用）
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'audioCapture');
    });
    try {
      session.defaultSession.setDevicePermissionHandler((details) => {
        return details.deviceType === 'media';
      });
    } catch (e) {}

    if (isSmoke) {
      setTimeout(() => {
        fs.writeFileSync(path.join(app.getPath('userData'), 'smoke.txt'), 'OK=false\nMSG=timeout\n');
        app.exit(1);
      }, 90 * 1000);
    }
    if (isDiag) {
      // 诊断模式：启动 4 秒后自动截图到 diag.png
      setTimeout(async () => {
        try {
          if (win && !win.isDestroyed()) {
            const img = await win.capturePage();
            fs.writeFileSync(path.join(app.getPath('userData'), 'diag.png'), img.toPNG());
            log('diag screenshot saved:', path.join(app.getPath('userData'), 'diag.png'));
          }
        } catch (e) {
          log('diag screenshot failed:', e && e.message);
        }
      }, 4000);
    } else {
      // 常规模式也自动截图（便于排查显示问题），保存最近一张 pet.png
      setTimeout(async () => {
        try {
          if (win && !win.isDestroyed()) {
            const img = await win.capturePage();
            fs.writeFileSync(path.join(app.getPath('userData'), 'pet.png'), img.toPNG());
          }
        } catch (e) {
          log('auto screenshot failed:', e && e.message);
        }
      }, 5000);
    }
  });

  app.on('window-all-closed', () => {
    if (isSmoke || quitting) app.quit();
  });

  app.on('will-quit', () => {
  });
}
