# FastMCP Browser Baseline and Integration Status

Tanggal: 2026-09-22

## Status integrasi

Implementasi MVP sudah memiliki MCP server stdio, bridge WebSocket loopback pada `127.0.0.1`, extension Manifest V3 untuk Chromium dan Firefox, semantic snapshot, inventory, DOM actions, arbitrary page-context evaluation, pointer fallback, storage, cookies, download, screenshot, dan status UI.

Runtime path baru tidak memakai `chrome.debugger`, CDP, native host, atau Playwright sebagai control path. Upload file lokal tetap `UNSUPPORTED_CAPABILITY` karena extension-only API tidak dapat mengendalikan OS file chooser.

## Verifikasi otomatis

| Check | Hasil |
|---|---:|
| Server build dan typecheck | PASS |
| Server/workflow tests | 13 pass, 0 fail |
| Extension unit/security tests | 25 pass, 0 fail |
| Chromium extension build | PASS |
| Firefox extension build | PASS |
| Bundled JavaScript syntax checks | PASS |
| Migration no-CDP/no-debugger checks | PASS |
| Browser session smoke test | NOT RUN |

Test workflow contract mencakup discovery, open, snapshot, inventory, fill, pointer click, cookies, storage, download, screenshot, close, serta isolasi unknown tool sebelum bridge execution. Test extension mencakup authorization tab, page-originated privileged command rejection, stale references, password redaction, pointer click/drag, adapter normalization, dan status UI.

## Bridge benchmark

Command: `node benchmarks/bridge-benchmark.mjs` setelah `npm run build` pada `server`.

```json
{
  "iterations": 50,
  "coldStartMs": 2.735,
  "medianMs": 0.374,
  "p95Ms": 3.146,
  "throughputPerSecond": 1414.43,
  "heapDeltaBytes": 473208
}
```

Angka ini mengukur persistent local bridge request/response menggunakan fake authenticated WebSocket peer. Angka ini bukan latency end-to-end extension/browser dan belum mengukur service-worker memory atau variasi 1, 5, dan 20 tab.

## Cross-browser integration status

Build dan contract portable untuk Chromium serta Firefox sudah diverifikasi. Smoke test dengan browser nyata belum dijalankan dalam sesi ini, sehingga belum ada klaim bahwa unpacked extension sudah berhasil handshake dan menjalankan workflow penuh pada Chrome, Edge, Opera, Brave, Vivaldi, atau Firefox.

Langkah yang masih terbuka:

1. Load `extension/dist/chromium` sebagai unpacked extension pada browser Chromium nyata.
2. Load `extension/dist/firefox` sebagai temporary add-on pada Firefox nyata.
3. Jalankan fixture workflow dan catat perbedaan capability yang benar-benar terlihat.
4. Perluas benchmark menjadi end-to-end dan variasi jumlah tab setelah browser session tersedia.
