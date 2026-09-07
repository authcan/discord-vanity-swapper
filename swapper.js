'use strict';

const http2 = require('node:http2');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const { initMFA } = require('discord-mfa-solver');

os.setPriority(0, -20);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const token = cfg.token;
const password = cfg.password;
const serverID = cfg.serverID;
const vanityURL = cfg.vanityURL;
const manualMfa = cfg.mfa || '';

if (!vanityURL || vanityURL === 'BURAYA_YAZ') {
  console.log('[HATA] config.json icinde vanityURL doldur!');
  process.exit(1);
}
if (!token || (!password && !manualMfa)) {
  console.log('[HATA] config.json icinde token + password (veya manuel mfa) sart!');
  process.exit(1);
}

const CLAIM_COUNT = Number(cfg.claimCount) || 5;
const COUNTDOWN_S = Number(cfg.countdown) || 1;
const HOST = 'canary.discord.com';

const EV = '37.6.0', CV = '138.0.7204.251', BV = '1.0.816';
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${BV} Chrome/${CV} Electron/${EV} Safari/537.36`;
const XSP = 'eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0LCJkZXZpY2UiOiJhbnRoZWwifQ==';

const PATCH_PAYLOAD = Buffer.from(JSON.stringify({ code: vanityURL }));

const session = http2.connect(`https://${HOST}`, {
  protocol: 'https:',
  settings: { enablePush: false, initialWindowSize: 65535 * 16 },
  createConnection: () => {
    const s = tls.connect({
      host: HOST, port: 443,
      servername: HOST,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
      ALPNProtocols: ['h2'],
      ecdhCurve: 'X25519:P-256:P-384',
      honorCipherOrder: true
    });
    s.setNoDelay(true);
    s.setKeepAlive(true, 500);
    return s;
  },
  rejectUnauthorized: false,
  servername: HOST,
  ALPNProtocols: ['h2'],
  paddingStrategy: http2.constants.PADDING_STRATEGY_NONE
});

session.ref();
session.on('error', e => { console.log('[H2] Hata:', e.message); process.exit(1); });
session.on('close', () => { console.log('[H2] Kapandi'); process.exit(1); });

const mfa = initMFA({
  TOKEN: token,
  PASSWORD: password,
  GUILD_IDS: [serverID],
  log: (tag, msg) => console.log(`[${tag}] ${msg}`)
});

function fireHdrs() {
  if (manualMfa) {
    return {
      ':method': 'PATCH',
      ':path': `/api/v9/guilds/${serverID}/vanity-url`,
      'authorization': token,
      'content-type': 'application/json',
      'user-agent': UA,
      'x-super-properties': XSP,
      'x-discord-mfa-authorization': manualMfa
    };
  }
  return {
    ':method': 'PATCH',
    ':path': `/api/v9/guilds/${serverID}/vanity-url`,
    ...mfa.getFireHdrs(0)
  };
}

function fireSwap() {
  const patches = [];
  const hdrs = fireHdrs();
  for (let i = 0; i < CLAIM_COUNT; i++) {
    const req = session.request(hdrs);
    req.on('response', h => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => console.log(`${h[':status']} | ${raw.slice(0, 60)}`));
    });
    req.on('error', e => console.log(`[PATCH #${i + 1}] err: ${e.message}`));
    patches.push(req);
  }

  const del = session.request({
    ':method': 'DELETE',
    ':path': `/api/v9/invites/${vanityURL}`,
    'authorization': token,
    'content-type': 'application/json',
    'x-discord-mfa-authorization': manualMfa || mfa.mfaToken || ''
  });
  del.on('response', h => {
    console.log('[DELETE]', h[':status']);
    Promise.all(patches.map(req => { req.write(PATCH_PAYLOAD); req.end(); }));
  });
  del.on('error', e => console.log('[DELETE] err:', e.message));
  del.end();
}

async function countdown() {
  for (let i = COUNTDOWN_S; i > 0; i--) {
    process.stdout.write(`\r[COUNTDOWN] ${i}...   `);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\r                        \r');
  fireSwap();
}

async function mfaHazirOl() {
  for (let deneme = 1; ; deneme++) {
    console.log(`[MFA] Token aliniyor (deneme ${deneme})...`);
    try {
      const ok = await mfa.refreshMfa();
      if (ok && mfa.canSnipe) {
        console.log(`[MFA] Hazir (host: ${mfa.host})`);
        return;
      }
      console.log('[MFA] Basarisiz:', (mfa.lastError && mfa.lastError.message) || 'bilinmiyor');
    } catch (e) {
      console.log('[MFA] Hata:', e.message);
    }
    await new Promise(r => setTimeout(r, Math.min(deneme * 5000, 30000)));
  }
}

session.once('connect', async () => {
  try { session.setLocalWindowSize(1024 * 1024 * 16); } catch (_) {}
  console.log('[H2] Baglanti kuruldu');
  setInterval(() => {
    try { session.request({ ':method': 'HEAD', ':path': '/api/v9/gateway' }, { endStream: true }).end(); } catch (_) {}
  }, 3500);
  console.log(`[CFG] Server: ${serverID} | Vanity: ${vanityURL}`);
  if (manualMfa) {
    console.log('[MFA] Configden alindi (manuel)');
  } else {
    await mfaHazirOl();
  }
  await countdown();
});
