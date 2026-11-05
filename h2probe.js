
const http2 = require('http2');
const host = 'account-public-service-prod03.ol.epicgames.com';
const body = 'grant_type=client_credentials';
function tryReq(forceH2) {
  return new Promise((resolve) => {
    const client = http2.connect('https://' + host, { settings: {} });
    const req = client.request({
      ':method': 'POST',
      ':path': '/account/api/oauth/token',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      'user-agent': 'EpicGamesLauncher/20.2.0-56643808+++UE5+Release-Distro-5.5',
    });
    let data = '', status = 0;
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => { client.close(); resolve({ status, len: data.length, sample: data.slice(0, 80) }); });
    req.on('error', (e) => { client.close(); resolve({ error: e.message }); });
    req.end(body);
    setTimeout(() => { try { client.close(); } catch {} resolve({ status, len: data.length, timeout: true }); }, 15000);
  });
}
(async () => {
  console.log('H2:', JSON.stringify(await tryReq(true)));
})();
