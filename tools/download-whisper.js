// 下载 whisper.cpp（Windows x64）与中文模型 ggml-small.bin —— 走本地代理 127.0.0.1:7897
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROXY = { host: '127.0.0.1', port: Number(process.env.PROXY_PORT || 7897) };

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
        if (res2.statusCode !== 200) { res2.resume(); return reject(new Error('HTTP ' + res2.statusCode + ' ' + urlStr)); }
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

async function downloadOne(url, out, minSize) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > minSize) { console.log('skip (已存在):', out); return true; }
  console.log('下载:', url);
  try {
    const buf = await getViaProxy(url);
    if (buf.length < minSize) throw new Error('too small: ' + buf.length);
    fs.writeFileSync(out, buf);
    console.log('完成:', out, (buf.length / 1024 / 1024).toFixed(1), 'MB');
    return true;
  } catch (e) {
    console.error('失败:', out, e.message);
    try { fs.unlinkSync(out); } catch (e2) {}
    return false;
  }
}

function getDirect(urlStr, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('too many redirects'));
    const u = new URL(urlStr);
    const req = https.get(u, {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' },
      timeout: 30000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getDirect(new URL(res.headers.location, urlStr).toString(), redirects - 1));
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

async function downloadOneDirect(url, out, minSize) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > minSize) { console.log('skip (已存在):', out); return true; }
  console.log('直连下载:', url);
  try {
    const buf = await getDirect(url);
    if (buf.length < minSize) throw new Error('too small: ' + buf.length);
    fs.writeFileSync(out, buf);
    console.log('完成:', out, (buf.length / 1024 / 1024).toFixed(1), 'MB');
    return true;
  } catch (e) {
    console.error('直连失败:', out, e.message);
    try { fs.unlinkSync(out); } catch (e2) {}
    return false;
  }
}

(async () => {
  let ok = true;
  // 1. 最新 release 的 whisper-bin-x64.zip
  try {
    const rel = JSON.parse((await getViaProxy('https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest')).toString());
    const asset = rel.assets.find(a => /whisper-bin-x64\.zip$/i.test(a.name));
    if (!asset) throw new Error('no whisper-bin-x64 asset, tag=' + rel.tag_name);
    console.log('release:', rel.tag_name, '|', asset.name, (asset.size / 1024 / 1024).toFixed(1), 'MB');
    ok = (await downloadOne(asset.browser_download_url, path.join(__dirname, '..', 'vendor', 'whisper', 'whisper-bin-x64.zip'), 1024 * 1024)) && ok;
  } catch (e) { console.error('release 查询失败:', e.message); ok = false; }
  // 2. 中文模型 ggml-small.bin（优先 hf-mirror 国内镜像：直连 → 代理；失败回退 huggingface 走代理）
  let modelOk = await downloadOneDirect('https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', path.join(__dirname, '..', 'vendor', 'whisper', 'ggml-small.bin'), 200 * 1024 * 1024);
  if (!modelOk) modelOk = await downloadOne('https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', path.join(__dirname, '..', 'vendor', 'whisper', 'ggml-small.bin'), 200 * 1024 * 1024);
  if (!modelOk) modelOk = await downloadOne('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', path.join(__dirname, '..', 'vendor', 'whisper', 'ggml-small.bin'), 200 * 1024 * 1024);
  ok = modelOk && ok;
  console.log(ok ? 'ALL OK' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})();
