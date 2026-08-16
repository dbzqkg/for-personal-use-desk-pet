// 下载 Piper TTS（Windows）与中文模型 —— 支持本地代理（默认 127.0.0.1:7897）
const https = require('https');
const http = require('http');
const fs = require('fs');

const PROXY = { host: '127.0.0.1', port: Number(process.env.PROXY_PORT || 7897) };

function getViaProxy(urlStr, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('too many redirects'));
    const u = new URL(urlStr);
    const connectReq = http.request({
      host: PROXY.host,
      port: PROXY.port,
      method: 'CONNECT',
      path: u.hostname + ':443',
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error('CONNECT ' + res.statusCode)); return; }
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0' },
        createConnection: () => socket,
        agent: false,
      }, res2 => {
        if (res2.statusCode >= 300 && res2.statusCode < 400 && res2.headers.location) {
          res2.resume();
          return resolve(getViaProxy(new URL(res2.headers.location, urlStr).toString(), redirects - 1));
        }
        if (res2.statusCode !== 200) { res2.resume(); return reject(new Error('HTTP ' + res2.statusCode + ' ' + urlStr)); }
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

async function downloadOne(url, out, minSize = 1000) {
  if (fs.existsSync(out) && fs.statSync(out).size > minSize) { console.log('skip', out); return true; }
  try {
    const buf = await getViaProxy(url);
    if (buf.length < minSize) throw new Error('too small: ' + buf.length);
    fs.writeFileSync(out, buf);
    console.log('OK', out, buf.length);
    return true;
  } catch (e) {
    console.error('FAIL', url, e.message);
    return false;
  }
}

(async () => {
  const base = 'D:\\Develop\\code\\live2d-desktop-pet\\vendor\\piper';
  fs.mkdirSync(base, { recursive: true });
  // 中文模型（hf-mirror 优先，官方兜底）
  const onnx = 'zh_CN-huayan-medium.onnx';
  const onnxJson = 'zh_CN-huayan-medium.onnx.json';
  await downloadOne('https://hf-mirror.com/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/' + onnx, base + '\\' + onnx, 1000000);
  await downloadOne('https://hf-mirror.com/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/' + onnxJson, base + '\\' + onnxJson, 100);
  if (!fs.existsSync(base + '\\' + onnx) || fs.statSync(base + '\\' + onnx).size < 1000000) {
    await downloadOne('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/' + onnx, base + '\\' + onnx, 1000000);
  }
  // piper exe（GitHub releases）
  await downloadOne('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', base + '\\piper_windows_amd64.zip', 100000);
})();
