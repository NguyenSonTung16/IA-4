// The router: splits traffic between the two slots by weight. It stands in for the load
// balancer of a real deployment, and it never retries, so a failure reaches the client.
//
//   :8080  traffic
//   :8081  control:  GET /state        weights and per-slot counters
//                    POST /weights     {"blue": 90, "green": 10}, must add up to 100
//                    POST /mark        any text; shows up in the load log
import { createServer, request } from 'node:http';

const slots = {
  blue: { weight: 100, requests: 0, errors: 0 },
  green: { weight: 0, requests: 0, errors: 0 },
};
const marks = [];

function pick() {
  return Math.random() * 100 < slots.blue.weight ? 'blue' : 'green';
}

function fail(res, name, status, code) {
  slots[name].errors++;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'x-slot': name });
  res.end(JSON.stringify({ error: 'bad_gateway', slot: name, code }));
}

const traffic = createServer((req, res) => {
  const name = pick();
  const slot = slots[name];
  slot.requests++;
  const up = request({ host: name, port: 3000, method: req.method, path: req.url, headers: req.headers, agent: false, timeout: 10_000 }, (upRes) => {
    if (upRes.statusCode >= 500) slot.errors++;
    res.writeHead(upRes.statusCode, { ...upRes.headers, 'x-slot': name });
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  up.on('error', (e) => fail(res, name, e.code === 'TIMEOUT' ? 504 : 502, e.code ?? 'ERROR'));
  req.pipe(up);
});
// A client's idle connection must not be closed under it: that would count as a failed request.
traffic.keepAliveTimeout = 65_000;
traffic.listen(8080);

const control = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/state') return reply(200, { slots, marks });
  if (req.method === 'POST' && req.url === '/mark') {
    marks.push({ at: Date.now(), text: raw.slice(0, 200) });
    return reply(200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/weights') {
    let w;
    try { w = JSON.parse(raw); } catch { return reply(400, { error: 'not JSON' }); }
    if (!Number.isInteger(w.blue) || !Number.isInteger(w.green) || w.blue < 0 || w.green < 0 || w.blue + w.green !== 100)
      return reply(400, { error: 'blue and green must be whole numbers that add up to 100' });
    slots.blue.weight = w.blue;
    slots.green.weight = w.green;
    console.log(`weights blue=${w.blue} green=${w.green}`);
    return reply(200, { slots, marks });
  }
  reply(404, { error: 'no such route' });
});
control.keepAliveTimeout = 65_000;
control.listen(8081, () => console.log('router: traffic on :8080, control on :8081'));
