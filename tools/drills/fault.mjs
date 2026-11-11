// The bad release: 30% of the reads of a link fail with a 500. /health stays green, the
// way it usually does in a bad release. Loaded before your code; your code is not changed.
import http from 'node:http';

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === 'request' && /^\/(links|r)\/[^/?]+/.test(req.url) && Math.random() < 0.3) {
    res.writeHead(500, { 'content-type': 'application/json', 'x-app-version': process.env.APP_VERSION });
    res.end(JSON.stringify({ error: 'bad_release' }));
    return true;
  }
  return emit.call(this, event, req, res, ...rest);
};
