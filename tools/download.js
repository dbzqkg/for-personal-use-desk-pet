// 通用下载脚本（沙箱内 schannel TLS 不可用，用 Node 的 OpenSSL 下载）
const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

async function download(urlStr, outPath, redirects = 6) {
  if (redirects <= 0) throw new Error('too many redirects');
  const u = new URL(urlStr);
  const mod = u.protocol === 'https:' ? https : http;
  const res = await new Promise((resolve, reject) => {
    mod.get(u, { headers: { 'user-agent': 'Mozilla/5.0' } }, r => resolve(r)).on('error', reject);
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    return download(new URL(res.headers.location, u).toString(), outPath, redirects - 1);
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error('HTTP ' + res.statusCode + ' ' + urlStr);
  }
  const f = fs.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    res.pipe(f);
    f.on('finish', resolve);
    f.on('error', reject);
  });
  return fs.statSync(outPath).size;
}

(async () => {
  try {
    const size = await download(process.argv[2], process.argv[3]);
    console.log('OK', size);
  } catch (e) {
    console.error('FAIL', e.message);
    process.exit(1);
  }
})();
