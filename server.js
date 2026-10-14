// Twilio Voice & ElevenLabs AI Calling Server (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

// Load environment variables from .env
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch {}

const {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_NUMBER,
  TWIML_APP_SID,
  TWILIO_API_KEY: KEY,
  TWILIO_API_SECRET: SECRET,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_PHONE_NUMBER_ID,
  PORT = process.env.PORT || 3000
} = process.env;

const AUTH = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const API = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const DB = path.join(__dirname, 'calls.json');
const FINAL = ['completed', 'failed', 'busy', 'no-answer', 'canceled', 'done'];

const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const tw = (p, opts = {}) => fetch(API + p, { ...opts, headers: { Authorization: AUTH, ...(opts.headers || {}) } });

// Normalize phone numbers to E.164
const norm = (n) => {
  n = String(n || '').replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(n)) return '+91' + n;
  if (/^91\d{10}$/.test(n)) return '+' + n;
  return n.startsWith('+') ? n : '+' + n;
};

// Parse URL-encoded or JSON body
const readBodyStr = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (chunk) => (s += chunk));
  req.on('end', () => resolve(s));
});

const readBodyJSON = async (req) => {
  const str = await readBodyStr(req);
  try { return JSON.parse(str); } catch { return {}; }
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const xml = (res, code, twimlStr) => {
  res.writeHead(code, { 'Content-Type': 'text/xml; charset=utf-8' });
  res.end(twimlStr);
};

// Sync call status, duration, recording and transcript from Twilio or ElevenLabs
async function refresh(c) {
  if (!c || !c.sid) return c;
  if (c.noRec || (FINAL.includes(c.status) && (c.recording || c.status !== 'completed'))) return c;

  // Handle ElevenLabs AI Calls
  if (c.type === 'ai') {
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${c.conversation_id}`, {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY }
      });
      if (r.ok) {
        const j = await r.json();
        const rawStatus = (j.status || '').toLowerCase();
        if (rawStatus === 'done' || rawStatus === 'completed') {
          c.status = 'completed';
        } else if (rawStatus === 'failed') {
          c.status = 'failed';
        } else if (rawStatus === 'processing' || rawStatus === 'in-progress') {
          c.status = 'in-progress';
        } else if (rawStatus) {
          c.status = rawStatus;
        }

        if (j.metadata && j.metadata.call_duration_secs !== undefined) {
          c.duration = String(j.metadata.call_duration_secs);
        }

        if (j.analysis && j.analysis.transcript_summary) {
          c.transcriptSummary = j.analysis.transcript_summary;
        }

        if (j.transcript && Array.isArray(j.transcript)) {
          c.transcript = j.transcript;
        }

        if (c.status === 'completed' && !c.recording) {
          c.recording = c.conversation_id;
        }
      }
    } catch (err) {
      console.error('ElevenLabs sync error for conversation:', c.conversation_id, err.message);
    }
    return c;
  }

  // Handle Standard Twilio Calls
  try {
    const r = await tw(`/Calls/${c.sid}.json`);
    if (r.ok) {
      const j = await r.json();
      c.status = (j.status || c.status).toLowerCase();
      if (j.duration !== undefined && j.duration !== null) {
        c.duration = j.duration;
      }
      if (j.status === 'completed' && !c.recording) {
        const rr = await (await tw(`/Calls/${c.sid}/Recordings.json`)).json();
        if (rr.recordings && rr.recordings[0]) {
          c.recording = rr.recordings[0].sid;
        } else if (Date.now() - (c.startedAt || 0) > 120000) {
          c.noRec = true;
        }
      }
    }
  } catch (err) {
    console.error('Twilio sync error for SID:', c.sid, err.message);
  }
  return c;
}

http.createServer(async (req, res) => {
  try {
    // Serve HTML Dashboard
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }

    // Serve local Twilio Voice SDK bundle
    if (req.method === 'GET' && (req.url === '/twilio.min.js' || req.url === '/twilio-voice.min.js')) {
      const sdkPath = path.join(__dirname, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(fs.readFileSync(sdkPath));
    }

    // Config endpoint
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, { from: TWILIO_NUMBER || '' });
    }

    // Token Endpoint for Twilio Voice JavaScript SDK
    if (req.method === 'GET' && req.url === '/api/token') {
      if (!SID || !KEY || !SECRET || !TWIML_APP_SID) {
        return json(res, 500, { error: 'Twilio API Key/Secret or TwiML App SID missing in configuration.' });
      }

      const AccessToken = twilio.jwt.AccessToken;
      const VoiceGrant = AccessToken.VoiceGrant;

      const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: TWIML_APP_SID,
        incomingAllow: true
      });

      const token = new AccessToken(SID, KEY, SECRET, {
        identity: 'web-user',
        ttl: 3600
      });
      token.addGrant(voiceGrant);

      return json(res, 200, { token: token.toJwt(), identity: 'web-user' });
    }

    // ElevenLabs AI Outbound Call Endpoint
    if (req.method === 'POST' && req.url === '/api/ai-call') {
      const b = await readBodyJSON(req);
      const rawTo = b.to;
      if (!rawTo) {
        return json(res, 400, { error: 'Please enter a target phone number.' });
      }

      const formattedTo = norm(rawTo);
      if (!/^\+[1-9]\d{7,14}$/.test(formattedTo)) {
        return json(res, 400, { error: 'Invalid E.164 phone number format.' });
      }

      if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        return json(res, 500, { error: 'ElevenLabs API Key, Agent ID, or Phone Number ID missing in configuration.' });
      }

      const resEleven = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          agent_id: ELEVENLABS_AGENT_ID,
          agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID,
          to_number: formattedTo
        })
      });

      const j = await resEleven.json();

      if (!resEleven.ok) {
        const errMsg = j.detail || j.message || j.error || (typeof j === 'string' ? j : 'ElevenLabs AI Call failed');
        return json(res, resEleven.status || 400, { error: errMsg });
      }

      const conversation_id = j.conversation_id || j.conversationId;
      const callSid = j.call_sid || j.callSid || j.sid;

      const list = load();
      list.unshift({
        type: 'ai',
        sid: conversation_id,
        conversation_id,
        callSid,
        to: formattedTo,
        status: 'in-progress',
        startedAt: Date.now()
      });
      save(list);

      return json(res, 200, { success: true, conversation_id, callSid });
    }

    // TwiML Webhook called by Twilio when browser dials out
    if (req.method === 'POST' && req.url === '/voice') {
      const rawBody = await readBodyStr(req);
      const params = new URLSearchParams(rawBody);
      const toNum = params.get('To') || '';

      const isValidE164 = /^\+[1-9]\d{7,14}$/.test(toNum);

      if (isValidE164) {
        const responseTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${TWILIO_NUMBER}" record="record-from-answer-dual">
    <Number>${toNum}</Number>
  </Dial>
</Response>`;
        return xml(res, 200, responseTwiML);
      } else {
        const invalidTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Invalid destination phone number.</Say>
  <Hangup/>
</Response>`;
        return xml(res, 200, invalidTwiML);
      }
    }

    // Log active call triggered by frontend after call accept
    if (req.method === 'POST' && req.url === '/api/calls/log') {
      const b = await readBodyJSON(req);
      const { sid, to } = b;
      if (!sid || !to) {
        return json(res, 400, { error: 'Call SID and destination number are required.' });
      }

      const list = load();
      const existing = list.find((item) => item.sid === sid);
      if (!existing) {
        list.unshift({
          type: 'twilio',
          sid,
          to,
          status: 'in-progress',
          startedAt: Date.now()
        });
        save(list);
      }
      return json(res, 200, { success: true });
    }

    // Sync & return recent call logs
    if (req.method === 'GET' && req.url === '/api/calls') {
      const list = await Promise.all(load().slice(0, 30).map(refresh));
      save(list);
      return json(res, 200, list);
    }

    // ElevenLabs AI Audio proxy route
    const mAi = req.url.match(/^\/ai-rec\/(.+)$/);
    if (req.method === 'GET' && mAi) {
      const convId = decodeURIComponent(mAi[1]);
      const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${convId}/audio`, {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY }
      });

      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, {
          'Content-Type': r.headers.get('content-type') || 'audio/mpeg',
          'Content-Length': buf.length
        });
        return res.end(buf);
      }
      return json(res, r.status || 404, { error: 'ElevenLabs recording audio not found' });
    }

    // Twilio Audio recording proxy route
    const m = req.url.match(/^\/rec\/(RE\w+|CA\w+)$/);
    if (req.method === 'GET' && m) {
      const targetId = m[1];
      let recSid = targetId;

      if (targetId.startsWith('CA')) {
        const list = load();
        const callObj = list.find((item) => item.sid === targetId);
        if (callObj && callObj.recording) {
          recSid = callObj.recording;
        } else {
          const rr = await (await tw(`/Calls/${targetId}/Recordings.json`)).json();
          if (rr.recordings && rr.recordings[0]) {
            recSid = rr.recordings[0].sid;
          }
        }
      }

      const r = await tw(`/Recordings/${recSid}.mp3`);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': buf.length
      });
      return res.end(buf);
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Server error:', e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Twilio & ElevenLabs AI Calling app running on port ${PORT}`));