// Taskbench egress allowlist (DESIGN §3.1): a local HTTP proxy the agent's
// environment points at. CONNECTs to allowed hosts are tunneled through the
// upstream proxy. Direct egress is closed by the caller's network jail
// (net-jail.sh) — inside the jail only this proxy's bind IP is routable, so
// unsetting the proxy yields no network, not open network; everything else
// is denied and logged. The deny log feeds NETWORK_FETCH_ATTEMPT; an allowed
// non-API host would be NETWORK_EXPOSURE (none are allowed beyond the model
// API). The Claude Code CLI's telemetry endpoints (statsig.anthropic.com,
// sentry.io) were on this list through round 3 and are now BLOCKED: the CLI
// runs without them, and an allowed non-API host is an exposure surface the
// header above claimed did not exist. Expect DENY lines for them in the log —
// they are the CLI's own telemetry, not agent retrieval attempts.
// Usage: node allowlist-proxy.mjs <port> <denylog> [bind-addr] [upstream-url]
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const [port, denylog, bindAddr = '127.0.0.1', upstreamArg] = process.argv.slice(2);
const ALLOW = new Set(['api.anthropic.com']);
// Bound on a request/response head held in memory before a decision is made:
// the client side is Node's own parser limit (maxHeaderSize below), the
// upstream side is the buffer in the CONNECT handler.
const HEAD_LIMIT = 16 * 1024;
// Upstream resolution (round-3.1 hygiene): the caller passes the freshly
// resolved upstream explicitly; the environment is only a fallback. The
// round-3 outage was a sweep-launch env snapshot going stale when the
// platform rotated the proxy port under a running process.
const up = new URL(upstreamArg || process.env.HTTPS_PROXY || process.env.https_proxy);
const upHost = up.hostname.replace(/^\[|\]$/g, '');   // URL keeps IPv6 brackets; net.connect wants none
const log = (line) => fs.appendFileSync(denylog, `${new Date().toISOString()} ${line}` + '\n');

// Parse an authority as it appears in a CONNECT request-target or a Host
// header: "host:port", "host", "[v6]:port", "[v6]". Bracketed IPv6 is one
// token and is parsed as such — a naive split(':') turned "[::1]:443" into
// host "[". Returns { host, port } (host lowercased, port null when absent)
// or null when the value is not an authority at all. The allow decision is
// an exact string match on the host, so an IP literal, v4 or v6, or any
// spelling other than the allowlisted hostname is denied.
function parseAuthority(s) {
  const m = /^(?:\[([0-9a-f:.]+(?:%[a-z0-9._~-]+)?)\]|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?))(?::([0-9]{1,5}))?$/i
    .exec(String(s ?? '').trim());
  if (!m) return null;
  const p = m[3] === undefined ? null : Number(m[3]);
  if (p !== null && (p < 1 || p > 65535)) return null;
  return { host: (m[1] ?? m[2]).toLowerCase(), port: p };
}

// The allow decision, taken on the PARSED request head only (Node has read
// the whole head, bounded by maxHeaderSize, before 'connect' fires): the
// CONNECT target must carry a port and name an allowlisted host exactly, and
// a Host header, when present, must name that same host (RFC 9110 §7.2).
function allowedTarget(req) {
  const target = parseAuthority(req.url);
  if (!target || target.port === null || !ALLOW.has(target.host)) return null;
  if (req.headers.host !== undefined) {
    const h = parseAuthority(req.headers.host);
    if (!h || h.host !== target.host || (h.port !== null && h.port !== target.port)) return null;
  }
  return target;
}

const server = http.createServer({ maxHeaderSize: HEAD_LIMIT }, (req, res) => {
  // plain-HTTP requests: deny all (the CLI uses CONNECT for TLS)
  log(`DENY HTTP ${req.method} ${req.url}`);
  res.writeHead(403); res.end('taskbench egress: denied');
});
server.on('connect', (req, clientSock, head) => {
  const target = allowedTarget(req);
  if (!target) {
    log(`DENY CONNECT ${req.url}${req.headers.host !== undefined ? ` host=${req.headers.host}` : ''}`);
    clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); clientSock.destroy();
    return;
  }
  const authority = `${target.host}:${target.port}`;
  log(`ALLOW CONNECT ${authority}`);
  const kill = () => { clientSock.destroy(); upSock.destroy(); };
  const upSock = net.connect(Number(up.port || 80), upHost, () => {
    upSock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
  // The upstream's reply head may span more than one chunk, and the chunk
  // that completes it may already carry tunnel bytes after the blank line.
  // Buffer up to the blank line (bounded: past HEAD_LIMIT without one the
  // tunnel is refused), judge the status line, hand the remainder to the
  // client, and only then start piping. `head` — whatever the client sent
  // after its own CONNECT head — is not forwarded before this point.
  // Refusals here are logged as FAIL, not DENY: DENY lines count as agent
  // fetch attempts (net_fetch_attempts), and an upstream fault is not one.
  let buf = Buffer.alloc(0);
  const onHead = (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buf.length > HEAD_LIMIT) { log(`FAIL CONNECT ${authority} upstream response head exceeded ${HEAD_LIMIT} bytes`); kill(); }
      return;
    }
    upSock.removeListener('data', onHead);
    upSock.removeListener('end', onEarlyEnd);
    const statusLine = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 200(?: |$)/.test(statusLine)) {
      log(`FAIL CONNECT ${authority} upstream replied: ${statusLine.slice(0, 200)}`);
      kill(); return;
    }
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upSock.write(head);
    const rest = buf.subarray(end + 4);
    if (rest.length) clientSock.write(rest);
    clientSock.pipe(upSock); upSock.pipe(clientSock);
  };
  const onEarlyEnd = () => { log(`FAIL CONNECT ${authority} upstream closed before a response head`); kill(); };
  upSock.on('data', onHead);
  upSock.on('end', onEarlyEnd);
  upSock.on('error', kill); clientSock.on('error', kill);
});
server.listen(Number(port), bindAddr, () => console.log(`allowlist proxy on ${bindAddr}:${port} -> ${up.hostname}:${up.port}`));
