# FastMCP Browser — Design Specification

**Tanggal:** 2026-09-22  
**Status:** Disetujui untuk review pengguna  
**Scope:** MVP extension-native untuk Chromium dan Firefox, tanpa CDP dan tanpa native host.

## 1. Tujuan

Membangun browser automation MCP yang lebih ringan dan cepat daripada bridge Playwright MCP saat ini. MCP server lokal menjadi antarmuka AI, sementara browser extension menjalankan operasi melalui WebExtension API dan content script.

Target utama:

- koneksi MCP yang persisten dan ringan;
- automation DOM dan input yang mudah dipahami AI;
- output ringkas berbasis semantic snapshot;
- dukungan core yang sama untuk Chrome-family dan Firefox;
- tidak menggunakan `chrome.debugger`, Chrome DevTools Protocol (CDP), atau native host pada MVP;
- capability browser-specific dilaporkan secara eksplisit, bukan disamarkan sebagai portable.

## 2. Non-goals MVP

MVP tidak menjamin fitur berikut secara lintas browser:

- raw DevTools tracing atau performance protocol;
- kontrol proses browser;
- arbitrary network interception;
- browser-level debugging protocol;
- akses unrestricted dari page ke extension background;
- stealth atau anti-detect behavior;
- penggantian total Playwright untuk semua use case.

Capability tersebut dapat ditambahkan sebagai adapter khusus pada fase berikutnya, tetapi tidak menjadi bagian dari core MVP.

## 3. Arsitektur

```text
AI Client
   │ MCP stdio
   ▼
FastMCP Server lokal
   │ satu WebSocket localhost persistent
   ▼
Extension service worker
   ├── Tab Manager
   ├── Command Router
   ├── Capability Registry
   └── Session/Auth Manager
        │ runtime messaging
        ▼
Content script per tab
   ├── Semantic Snapshot Engine
   ├── Page Inventory Engine
   ├── Element Reference Store
   ├── Input Controller
   ├── Pointer/Coordinate Controller
   ├── DOM Mutation Observer
   └── Page bridge untuk evaluate terbatas
```

### Komponen

**FastMCP Server** menerjemahkan MCP tool call menjadi command internal, memvalidasi input, mengelola WebSocket, meneruskan event browser, dan menormalisasi error.

**Extension service worker** menjadi gateway browser. Ia tidak melakukan parsing DOM halaman secara langsung; pekerjaan halaman dilakukan oleh content script yang terisolasi.

**Content script** membuat snapshot semantic, menyimpan reference elemen per tab, menjalankan aksi DOM/input, dan mengirim perubahan halaman yang relevan.

**Browser adapter** memisahkan interface core dari perbedaan `chrome.*` dan `browser.*`. Implementasi awalnya adalah `ChromiumAdapter` dan `FirefoxAdapter` dengan `CompatibilityAdapter` untuk normalisasi Promise, object tab, error, dan capability.

## 4. Alur data

1. MCP client menjalankan FastMCP Server melalui `stdio`.
2. FastMCP Server membuka WebSocket yang hanya bind ke `127.0.0.1`.
3. Extension tersambung dan mengirim handshake berisi versi protokol, versi extension, browser family, capability, dan tab yang tersedia.
4. MCP meminta `browser_snapshot` untuk tab tertentu atau tab aktif.
5. Content script membangun snapshot ringkas dan memberi `ref` lokal pada elemen interaktif.
6. AI memilih `ref` dan MCP mengirim command dengan `tabId` serta `revision`.
7. Content script memvalidasi reference, menjalankan aksi, lalu mengembalikan hasil.
8. Mutation observer atau event navigasi memberi tahu perubahan halaman tanpa polling tetap yang panjang.
9. Jika DOM sudah berubah, command lama menghasilkan `STALE_REF`; agent mengambil snapshot baru.

Semua pesan memakai envelope JSON sederhana dengan `id`, `method`, `params`, dan `result` atau `error`. Event asynchronous tidak memiliki `id` dan menggunakan method seperti `tab.updated`, `page.navigated`, dan `page.changed`.

## 5. Kontrak MCP MVP

### Tools

```text
browser_connect
browser_status
browser_tabs
browser_open
browser_close
browser_focus
browser_snapshot
browser_inventory
browser_click
browser_pointer_move
browser_pointer_click
browser_pointer_drag
browser_fill
browser_type
browser_press
browser_select
browser_scroll
browser_wait
browser_screenshot
browser_upload
browser_download
browser_cookies
browser_storage
browser_evaluate
browser_disconnect
```

Tool names di atas adalah kontrak tingkat MCP. Implementasi internal boleh menggunakan nama method yang lebih pendek, tetapi tidak boleh membocorkan API browser langsung ke client.

### Page inventory

`browser_inventory` melakukan satu kali pemindaian terstruktur terhadap halaman dan mengembalikan seluruh elemen penting dalam satu response, bukan memaksa agent memeriksa elemen satu per satu. Inventory mencakup:

- semua `input`, `textarea`, `select`, dan `contenteditable`;
- semua `button`, `a`, dan elemen dengan ARIA interactive role;
- heading dan landmark sebagai konteks struktur halaman;
- teks yang terlihat dan relevan, dikelompokkan berdasarkan section/container;
- status `disabled`, `checked`, `selected`, `required`, `visible`, dan `boundingBox` bila tersedia;
- `ref` yang dapat dipakai oleh command DOM maupun pointer.

Nilai sensitif seperti password, token, cookie, dan nilai input rahasia disensor. Inventory mendukung filter `interactive`, `text`, `forms`, `buttons`, `links`, `section`, dan `viewport` agar halaman besar tetap hemat response. Mode default mengembalikan semua elemen penting dengan batas ukuran dan pagination/section bila halaman terlalu besar.

Contoh:

```json
{
  "tabId": 42,
  "revision": 18,
  "forms": [
    {"ref":"e1","type":"email","label":"Email","required":true,"value":""},
    {"ref":"e2","type":"password","label":"Password","required":true,"value":"[REDACTED]"}
  ],
  "buttons": [
    {"ref":"e3","role":"button","text":"Sign in","disabled":false}
  ],
  "text": [
    {"ref":"t1","text":"Welcome back","container":"main"}
  ]
}
```

Inventory disimpan sebagai snapshot ber-revision yang sama dengan semantic snapshot agar AI dapat memilih target dari satu response.

### Pointer dan coordinate fallback

Untuk canvas, SVG, custom controls, elemen tanpa accessible name, atau halaman yang gagal dipetakan dengan baik ke DOM, tersedia fallback pointer:

- `browser_pointer_move` menggeser pointer ke coordinate atau target `ref`;
- `browser_pointer_click` melakukan click pada coordinate atau target `ref`;
- `browser_pointer_drag` melakukan drag dari titik awal ke titik akhir;
- `browser_scroll` menggeser halaman atau melakukan scroll pada target coordinate bila diperlukan;

Coordinate selalu terkait viewport tab dan response menyertakan ukuran viewport, scroll offset, serta URL/revision saat coordinate dihitung. Agent tidak mengandalkan coordinate lama setelah navigasi, resize, scroll besar, atau perubahan DOM. Jika target berbasis `ref`, extension menghitung `boundingBox` terbaru sebelum menjalankan pointer action.

Contoh:

```json
{
  "tabId": 42,
  "x": 612,
  "y": 388,
  "button": "left",
  "clickCount": 1,
  "revision": 18
}
```

Pointer action dijalankan melalui event/input API WebExtension yang tersedia, bukan CDP. Untuk cross-browser MVP, click dan move pada halaman biasa didukung; drag kompleks, pointer capture, dan input level OS dilaporkan melalui capability matrix bila tidak tersedia. Pointer automation adalah fallback, bukan metode default, karena semantic ref lebih stabil dan lebih mudah di-retry.

### Snapshot

```json
{
  "tabId": 42,
  "url": "https://example.com/login",
  "title": "Login",
  "revision": 18,
  "elements": [
    {"ref":"e1","role":"textbox","name":"Email","value":"","required":true},
    {"ref":"e2","role":"textbox","name":"Password","value":"","required":true},
    {"ref":"e3","role":"button","name":"Sign in","disabled":false}
  ]
}
```

Snapshot memprioritaskan `button`, `a`, `input`, `textarea`, `select`, ARIA interactive roles, `contenteditable`, elemen clickable, heading, dan landmark. Password value, cookie, token, dan full `innerHTML` tidak dikembalikan secara default. `browser_inventory` memakai engine yang sama, tetapi mengembalikan grouping forms/buttons/links/text dan dapat meminta bounding box untuk pointer fallback.

### Reference dan revision

Reference disimpan di content script dan berlaku hanya untuk tab serta revision terkait. DOM change yang relevan menaikkan `revision`. Command memakai reference lama dikembalikan sebagai:

```json
{
  "code": "STALE_REF",
  "message": "Snapshot is outdated.",
  "tabId": 42,
  "expectedRevision": 18,
  "actualRevision": 19,
  "retryable": true
}
```

Aksi tidak menggunakan selector CSS panjang sebagai kontrak utama. AI mengikuti siklus `snapshot → pilih ref → aksi → delta/error`.

### Command dan response

```json
{
  "id": "req-123",
  "method": "page.click",
  "params": {"tabId": 42, "ref": "e3", "revision": 18}
}
```

```json
{
  "id": "req-123",
  "ok": true,
  "result": {
    "tabId": 42,
    "url": "https://example.com/dashboard",
    "title": "Dashboard",
    "changed": true,
    "revision": 19
  }
}
```

### Error codes

```text
NO_CONNECTION
TAB_NOT_FOUND
TAB_NOT_ACCESSIBLE
STALE_REF
ELEMENT_NOT_FOUND
ELEMENT_NOT_INTERACTIVE
ACTION_TIMEOUT
NAVIGATION_TIMEOUT
PERMISSION_DENIED
UNSUPPORTED_CAPABILITY
INVALID_ARGUMENT
PAGE_BLOCKED
```

Error memiliki `code`, `message`, optional details, dan `retryable`. Agent harus dapat membedakan error yang pulih dengan snapshot ulang dari error konfigurasi atau permission.

## 6. Transport dan keamanan

- MCP memakai `stdio` agar kompatibel dengan MCP client umum.
- Extension dan server memakai satu WebSocket persistent di loopback.
- Server tidak bind ke alamat publik.
- Handshake memerlukan token yang tersimpan di extension storage.
- Origin dan koneksi client diverifikasi.
- Semua request memiliki `requestId`, timeout, dan mekanisme cancellation bila transport mendukungnya.
- Satu koneksi menangani banyak tab.
- Tab authorization tetap diperiksa pada setiap command.
- Page content diperlakukan sebagai data tidak tepercaya dan tidak boleh mengubah instruksi sistem agent.

`browser_evaluate` berjalan di page/content-script context, bukan background context. Ia memiliki timeout, batas ukuran hasil, dan tidak dapat membaca secret extension. Capability evaluate harus dapat dinonaktifkan.

## 7. Capability matrix

Handshake mengembalikan capability aktual, misalnya:

```json
{
  "browser": "firefox",
  "capabilities": {
    "tabs": true,
    "dom": true,
    "screenshot": true,
    "cookies": true,
    "storage": true,
    "network_observe": "partial",
    "network_intercept": false,
    "browser_debugger": false
  }
}
```

Core portable meliputi tab, navigasi, DOM snapshot, page inventory, click berbasis ref, pointer move/click/drag berbasis coordinate atau bounding box, fill, type, keyboard, select, scroll, wait, screenshot, cookie, storage, upload, dan download sesuai permission browser. Network observation, interception, debugging, pointer capture kompleks, dan performance capability dapat berbeda menurut browser dan harus mengembalikan `UNSUPPORTED_CAPABILITY` bila tidak tersedia.

## 8. Prinsip performa

- Tidak mengirim full HTML atau full accessibility tree pada operasi biasa.
- Tidak otomatis mengirim snapshot setelah setiap command bila halaman tidak berubah.
- Tidak memakai fixed delay panjang.
- Menunggu event navigasi, `DOMContentLoaded`, `load`, dan quiet period mutation pendek bila diperlukan.
- Snapshot dapat dibatasi ke section atau query semantik.
- Persistent WebSocket menghindari overhead reconnect.
- Reference dan revision menghindari pencarian ulang selector pada setiap aksi.
- Response default hanya mengembalikan delta penting.
- Benchmark wajib membandingkan cold start dan persistent connection.

## 9. Testing dan verifikasi

### Unit test

- filtering snapshot;
- perhitungan role dan accessible name;
- reference store;
- revision dan stale reference;
- validasi command;
- capability negotiation;
- normalisasi error adapter.

### Integration test

- MCP server ke WebSocket extension;
- extension ke content script;
- multi-tab;
- reconnect;
- navigation;
- tab close;
- Chromium;
- Firefox.

### Browser smoke test

Workflow minimum: open page, snapshot, inventory seluruh elemen penting, click berbasis ref, fill form, keyboard, pointer move, pointer click pada coordinate, pointer drag, scroll, screenshot, cookie/storage, download, dan upload.

### Pointer and inventory test

- halaman dengan banyak input, tombol, link, heading, dan teks harus dikembalikan dalam satu `browser_inventory`;
- elemen tanpa accessible name dapat ditemukan melalui bounding box atau coordinate;
- pointer click pada canvas/SVG/custom control dapat diverifikasi melalui event halaman;
- pointer drag mengembalikan capability error yang jelas bila browser/halaman tidak mendukungnya;
- coordinate lama setelah resize, scroll, atau revision change ditolak atau dihitung ulang;
- screenshot dan bounding box memakai viewport serta scroll offset yang sama.


### Security test

- koneksi non-loopback ditolak;
- token salah ditolak;
- evaluate tidak dapat membaca secret extension;
- page tidak dapat mengirim privileged command;
- tab authorization terisolasi;
- output sensitif tidak ikut snapshot default.

## 10. Kriteria sukses MVP

- Tidak ada pemakaian `chrome.debugger` atau CDP.
- Satu persistent WebSocket melayani beberapa tab.
- Chromium-family dan Firefox menjalankan core DOM automation yang sama.
- Snapshot interaktif jauh lebih kecil daripada full page HTML atau accessibility dump.
- Aksi umum selesai tanpa fixed delay panjang.
- `STALE_REF` dapat dipulihkan dengan mengambil snapshot baru.
- MCP client dapat menyelesaikan workflow login, form, dan navigasi secara konsisten.
- Capability yang tidak portable dilaporkan dengan jelas.

## 11. Keputusan desain

Pendekatan MVP yang dipilih adalah extension-native core tanpa CDP dan tanpa native host. Pendekatan ini paling ringan, cepat, portable, dan mudah diotomasi AI. Full browser internals tidak dijanjikan sebagai capability universal; jika nanti dibutuhkan, fitur tersebut ditambahkan melalui adapter browser-specific atau native helper tanpa mengubah kontrak core portable.

## 12. Di luar scope implementasi saat ini

Dokumen ini belum menentukan detail implementasi seperti pilihan library WebSocket, struktur package, schema validator, strategi bundling, format manifest Firefox, dan CI. Hal-hal tersebut akan ditentukan pada implementation plan setelah spec ini direview.
