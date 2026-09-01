// Taskbench egress allowlist (DESIGN §3.1): a local HTTP proxy the agent's
// environment points at. CONNECTs to allowed hosts are tunneled through the
// upstream proxy. Direct egress is closed by the caller's network jail
// (net-jail.sh) — inside the jail only this proxy's bind IP is routable, so
// unsetting the proxy yields no network, not open network; everything else
// is denied and logged. The deny log feeds NETWORK_FETCH_ATTEMPT; an allowed
// non-API host would be NETWORK_EXPOSURE (none are allowed in v1 beyond the
// model API).
// Usage: node allowlist-proxy.mjs <port> <denylog>
import net from 'node:net';
import http from 'node:http';

const [port, denylog, bindAddr = '127.0.0.1', upstreamArg] = process.argv.slice(2);
const ALLOW = new Set(['api.anthropic.com', 'statsig.anthropic.com', 'sentry.io']);
// Upstream resolution (round-3.1 hygiene): the caller passes the freshly
// resolved upstream explicitly; the environment is only a fallback. The
// round-3 outage was a sweep-launch env snapshot going stale when the
// platform rotated the proxy port under a running process.
const up = new URL(upstreamArg || process.env.HTTPS_PROXY || process.env.https_proxy);
const fs = await import('node:fs');
const log = (line) => fs.appendFileSync(denylog, `${new Date().toISOString()} ${line}` + '\n');

const server = http.createServer((req, res) => {
  // plain-HTTP requests: deny all (the CLI uses CONNECT for TLS)
  log(`DENY HTTP ${req.method} ${req.url}`);
  res.writeHead(403); res.end('taskbench egress: denied');
});
server.on('connect', (req, clientSock, head) => {
  const host = String(req.url).split(':')[0].toLowerCase();
  if (!ALLOW.has(host)) {
    log(`DENY CONNECT ${req.url}`);
    clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); clientSock.destroy();
    return;
  }
  log(`ALLOW CONNECT ${req.url}`);
  const upSock = net.connect(Number(up.port || 80), up.hostname, () => {
    upSock.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
  });
  let established = false;
  upSock.on('data', (d) => {
    if (!established) {
      established = true;
      if (!String(d).startsWith('HTTP/1.1 200') && !String(d).startsWith('HTTP/1.0 200')) {
        clientSock.destroy(); upSock.destroy(); return;
      }
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upSock.write(head);
      clientSock.pipe(upSock); upSock.pipe(clientSock);
    }
  });
  const kill = () => { clientSock.destroy(); upSock.destroy(); };
  upSock.on('error', kill); clientSock.on('error', kill);
});
server.listen(Number(port), bindAddr, () => console.log(`allowlist proxy on ${bindAddr}:${port} -> ${up.hostname}:${up.port}`));
