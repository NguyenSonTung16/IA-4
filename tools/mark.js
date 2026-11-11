// npm run mark -- "text"     leaves a line in the running load log.
const text = process.argv.slice(2).join(' ');
if (!text) { console.error('usage: npm run mark -- <text>'); process.exit(2); }
const r = await fetch('http://127.0.0.1:8081/mark', { method: 'POST', body: text }).catch(() => null);
if (!r?.ok) { console.error('the router is not answering on :8081'); process.exit(1); }
