import { WebSocket } from 'ws';
import { createBridge } from '../dist/src/bridge.js';

const iterations = Number(process.env.FASTMCP_BENCH_ITERATIONS ?? 50);
const port = 21000 + (process.pid % 500);
const bridge = createBridge(port, 'bench-token');
const socket = new WebSocket(`ws://127.0.0.1:${port}`);

await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
socket.send(JSON.stringify({ type: 'handshake', token: 'bench-token' }));
await new Promise((resolve, reject) => {
  socket.once('message', raw => JSON.parse(raw.toString()).type === 'handshake_ok' ? resolve() : reject(new Error('Handshake failed')));
  socket.once('error', reject);
});

const responses = new Map();
const waiters = new Map();
socket.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (!message.id) return;
  if (waiters.has(message.id)) {
    waiters.get(message.id)(message);
    waiters.delete(message.id);
  } else {
    responses.set(message.id, message);
  }
});

async function roundTrip() {
  const start = performance.now();
  const request = bridge.request('browser_status', {}, 5000);
  const id = `r${roundTrip.counter++}`;
  const incoming = await new Promise(resolve => {
    const existing = responses.get(id);
    if (existing) {
      responses.delete(id);
      resolve(existing);
    } else {
      waiters.set(id, resolve);
    }
  });
  socket.send(JSON.stringify({ id: incoming.id, ok: true, result: { connected: true } }));
  await request;
  return performance.now() - start;
}
roundTrip.counter = 1;

const before = process.memoryUsage().heapUsed;
const samples = [];
const coldStart = await roundTrip();
for (let index = 0; index < iterations; index += 1) samples.push(await roundTrip());
const after = process.memoryUsage().heapUsed;

samples.sort((a, b) => a - b);
const percentile = rank => samples[Math.min(samples.length - 1, Math.floor(samples.length * rank))];
console.log(JSON.stringify({
  iterations,
  coldStartMs: Number(coldStart.toFixed(3)),
  medianMs: Number(percentile(0.5).toFixed(3)),
  p95Ms: Number(percentile(0.95).toFixed(3)),
  throughputPerSecond: Number((1000 / (samples.reduce((sum, value) => sum + value, 0) / samples.length)).toFixed(2)),
  heapDeltaBytes: after - before
}, null, 2));

socket.close();
await bridge.close();
