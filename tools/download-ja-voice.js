// 下载日语 Piper 音色 ja_JA-hi_fi_captain-medium（hf-mirror 直连，失败走代理）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROXY = { host: '127.0.0.1', port: Number(process.env.PROXY_PORT || 7897) };

function getRaw(urlStr, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('too many redirects'));
    const u = new URL(urlStr);
    const req = https.get(u, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-encoding': 'identity' }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getRaw(new URL(res.headers.location, urlStr).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let got = 0;
      res.on('data', c => { chunks.push(c); got += c.length; if (got % (10 * 1024 * 1024) < c.length) console.log('  …', (got / 1024 / 1024).toFixed(0), 'MB'); });
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
    const cr = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: u.hostname + ':443' });
    cr.on('connect', (res, socket) => {
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
        res2.on('data', c => { chunks.push(c); got += c.length; if (got % (10 * 1024 * 1024) < c.length) console.log('  …', (got / 1024 / 1024).toFixed(0), 'MB'); });
        res2.on('end', () => resolve(Buffer.concat(chunks)));
        res2.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    cr.on('error', reject);
    cr.end();
  });
}

async function downloadOne(url, out, minSize) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out) && fs.statSync(out).size > minSize) { console.log('skip:', path.basename(out)); return true; }
  console.log('下载:', url);
  for (let a = 1; a <= 3; a++) {
    try {
      const buf = await getRaw(url);
      if (buf.length < minSize) throw new Error('too small ' + buf.length);
      fs.writeFileSync(out, buf);
      console.log('完成:', path.basename(out), (buf.length / 1024 / 1024).toFixed(1), 'MB');
      return true;
    } catch (e) {
      console.log(`第${a}次失败(${e.message})`);
      try { fs.unlinkSync(out); } catch (e2) {}
    }
  }
  console.log('改走代理…');
  try {
    const buf = await getViaProxy(url);
    if (buf.length < minSize) throw new Error('too small ' + buf.length);
    fs.writeFileSync(out, buf);
    console.log('完成(代理):', path.basename(out), (buf.length / 1024 / 1024).toFixed(1), 'MB');
    return true;
  } catch (e) {
    console.error('失败:', e.message);
    try { fs.unlinkSync(out); } catch (e2) {}
    return false;
  }
}

(async () => {
  const base = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/ja/ja_JA/hi_fi_captain/medium/';
  const V = path.join(__dirname, '..', 'vendor', 'piper');
  const ok1 = await downloadOne(base + 'ja_JA-hi_fi_captain-medium.onnx', path.join(V, 'ja_JA-hi_fi_captain-medium.onnx'), 30 * 1024 * 1024);
  const ok2 = await downloadOne(base + 'ja_JA-hi_fi_captain-medium.onnx.json', path.join(V, 'ja_JA-hi_fi_captain-medium.onnx.json'), 100);
  if (ok2) {
    // piper 1.2.0 不认多码点音素（如 aɪ）→ 从映射表删除（日语正常词不受影响）
    try {
      const jf = path.join(V, 'ja_JA-hi_fi_captain-medium.onnx.json');
      const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
      const m = j.phoneme_id_map || {};
      let n = 0;
      for (const k of Object.keys(m)) { if ([...k].length !== 1) { delete m[k]; n++; } }
      fs.writeFileSync(jf, JSON.stringify(j));
      console.log('已清理', n, '个多码点音素');
    } catch (e) { console.error('json 补丁失败:', e.message); }
  }
  console.log(ok1 && ok2 ? 'ALL OK' : 'SOME FAILED');
  process.exit(ok1 && ok2 ? 0 : 1);
})();
