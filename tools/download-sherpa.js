// 下载 sherpa-onnx 独立 exe + SenseVoice int8 模型 + tokens（hf-mirror 直连优先）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROXY = { host: '127.0.0.1', port: Number(process.env.PROXY_PORT || 7897) };

function getRaw(urlStr, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('too many redirects'));
    const u = new URL(urlStr);
    const req = https.get(u, {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' },
      timeout: 60000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getRaw(new URL(res.headers.location, urlStr).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let got = 0;
      res.on('data', c => { chunks.push(c); got += c.length; if (got % (20 * 1024 * 1024) < c.length) console.log('  …', (got / 1024 / 1024).toFixed(0), 'MB'); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getViaProxy(urlStr, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('too many redirects'));
    const u = new URL(urlStr);
    const connectReq = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: u.hostname + ':443' });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('CONNECT ' + res.statusCode)); return; }
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' },
        createConnection: () => socket, agent: false,
      }, res2 => {
        if (res2.statusCode >= 300 && res2.statusCode < 400 && res2.headers.location) {
          res2.resume();
          return resolve(getViaProxy(new URL(res2.headers.location, urlStr).toString(), redirects - 1));
        }
        if (res2.statusCode !== 200) { res2.resume(); return reject(new Error('HTTP ' + res2.statusCode)); }
        const chunks = [];
        let got = 0;
        res2.on('data', c => { chunks.push(c); got += c.length; if (got % (20 * 1024 * 1024) < c.length) console.log('  …', (got / 1024 / 1024).toFixed(0), 'MB'); });
        res2.on('end', () => resolve(Buffer.concat(chunks)));
        res2.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

async function downloadOne(url, out, minSize, fallbackUrl) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > minSize) { console.log('skip (已存在):', path.basename(out)); return true; }
  console.log('下载:', url);
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) { // 直连重试 4 次（大文件易被重置）
    try {
      const buf = await getRaw(url);
      if (buf.length < minSize) throw new Error('too small: ' + buf.length);
      fs.writeFileSync(out, buf);
      console.log('完成:', path.basename(out), (buf.length / 1024 / 1024).toFixed(1), 'MB');
      return true;
    } catch (e) {
      lastErr = e.message;
      console.log(`直连第 ${attempt} 次失败(${e.message})` + (attempt < 4 ? '，重试…' : ''));
      try { fs.unlinkSync(out); } catch (e2) {}
    }
  }
  if (!fallbackUrl) return false;
  console.log('改走备用源:', fallbackUrl);
  try {
    const buf = await getViaProxy(fallbackUrl);
    if (buf.length < minSize) throw new Error('too small: ' + buf.length);
    fs.writeFileSync(out, buf);
    console.log('完成(代理):', path.basename(out), (buf.length / 1024 / 1024).toFixed(1), 'MB');
    return true;
  } catch (e2) {
    console.error('备用源也失败:', e2.message);
    try { fs.unlinkSync(out); } catch (e3) {}
    return false;
  }
}

(async () => {
  const V = path.join(__dirname, '..', 'vendor', 'sherpa');
  const HF = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main';
  const HFX = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main';
  let ok = true;
  // 1. sherpa-onnx 命令行版（console，含 onnxruntime DLL；不是 GUI 版）
  ok = (await downloadOne('https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.5/sherpa-onnx-v1.13.5-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2', path.join(V, 'sherpa-cli.tar.bz2'), 10 * 1024 * 1024, null)) && ok;
  ok = (await downloadOne(HF + '/model.int8.onnx', path.join(V, 'model.int8.onnx'), 100 * 1024 * 1024, HF + '/model.int8.onnx')) && ok;
  ok = (await downloadOne(HF + '/tokens.txt', path.join(V, 'tokens.txt'), 1024, HFX + '/tokens.txt')) && ok;
  // 4. silero VAD 模型（~0.6MB，官方推荐 URL）
  ok = (await downloadOne('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', path.join(V, 'silero_vad.onnx'), 500 * 1024, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx')) && ok;
  console.log(ok ? 'ALL OK' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})();
