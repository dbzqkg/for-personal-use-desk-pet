// 下载英文 Piper 音色 en_US-lessac-medium（hf-mirror 直连）
const https = require('https');
const fs = require('fs');
const path = require('path');

function get(u) {
  return new Promise((res, rej) => {
    https.get(u, { headers: { 'user-agent': 'Mozilla/5.0' }, timeout: 120000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return res(get(new URL(r.headers.location, u).toString())); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const cs = [];
      let n = 0;
      r.on('data', c => { cs.push(c); n += c.length; if (n % (10 * 1048576) < c.length) console.log('  …', (n / 1048576).toFixed(0), 'MB'); });
      r.on('end', () => res(Buffer.concat(cs)));
      r.on('error', rej);
    }).on('error', rej);
  });
}
(async () => {
  const base = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/';
  const V = path.join(__dirname, '..', 'vendor', 'piper');
  const ok1 = await (async () => {
    for (let a = 1; a <= 4; a++) {
      try {
        const b = await get(base + 'en_US-lessac-medium.onnx');
        fs.writeFileSync(path.join(V, 'en_US-lessac-medium.onnx'), b);
        console.log('OK', (b.length / 1048576).toFixed(1), 'MB');
        return true;
      } catch (e) { console.log('retry', a, e.message); }
    }
    return false;
  })();
  const ok2 = await get(base + 'en_US-lessac-medium.onnx.json').then(b => {
    fs.writeFileSync(path.join(V, 'en_US-lessac-medium.onnx.json'), b);
    return true;
  }).catch(e => { console.log('json fail', e.message); return false; });
  console.log(ok1 && ok2 ? 'ALL OK' : 'SOME FAILED');
  process.exit(ok1 && ok2 ? 0 : 1);
})();
