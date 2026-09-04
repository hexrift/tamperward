// CI-only upstream proxy for the round-4 pilot.
//
// run-task4.sh's net-jail chains the agent's egress through an UPSTREAM HTTP proxy
// (UPSTREAM="${HTTPS_PROXY:-}"). In the frozen firecracker environment that upstream
// is the platform's mandatory agent proxy; a GitHub runner has direct internet and no
// such proxy, so UPSTREAM is empty and the preflight fails with
// "PREFLIGHT_NET_FAILED: no upstream proxy resolved".
//
// This is that upstream, and NOTHING more: a bare HTTP CONNECT forwarder that opens a
// raw TCP tunnel to the requested host:port. It performs NO allowlisting — the jail's
// own allowlist-proxy (allowlist-proxy.mjs) still enforces api.anthropic.com-only
// egress and remains the sole security boundary; this process only replaces the plumbing
// run-task4 expects the platform to provide. It carries no credentials (run-task4 refuses
// a credentialed upstream), binds loopback only, and is started for the run and torn down
// with the job.
//
//   node ci-upstream-proxy.mjs [port]    # default 8888, on 127.0.0.1
import net from 'node:net';
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.TB_UPSTREAM_PORT || 8888);
const HOST = '127.0.0.1';

const server = http.createServer((req, res) => {
  // Only CONNECT (HTTPS tunnelling) is used by the chained proxy; refuse the rest.
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('this upstream only tunnels CONNECT\n');
});

server.on('connect', (req, client, head) => {
  const [host, portStr] = String(req.url).split(':');
  const port = Number(portStr) || 443;
  const upstream = net.connect(port, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const drop = () => { try { client.destroy(); } catch {} try { upstream.destroy(); } catch {} };
  upstream.on('error', drop);
  client.on('error', drop);
});

server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
server.listen(PORT, HOST, () => {
  console.log(`ci-upstream-proxy: CONNECT forwarder listening on http://${HOST}:${PORT}`);
});
