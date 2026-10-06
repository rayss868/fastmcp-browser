// fingerprint.js — Main-world fingerprint patches for FastMCP Browser.
// MUST be injected with world: 'MAIN' so page JS sees the overrides.
// Standalone script: no imports, no exports — safe to executeScript directly.
(() => {
  if (window.__fastMcpFingerprintPatched) return;
  Object.defineProperty(window, '__fastMcpFingerprintPatched', { value: true, configurable: false });

  // --- navigator.webdriver ---------------------------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get() { return undefined; },
      configurable: true
    });
  } catch {}

  // --- navigator.plugins -----------------------------------------------------
  try {
    const chromePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpmpoikdogfddhjohp', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    chromePlugins.item = i => chromePlugins[i] ?? null;
    chromePlugins.namedItem = n => chromePlugins.find(p => p.name === n) ?? null;
    chromePlugins.refresh = () => {};
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get() { return chromePlugins; },
      configurable: true
    });
  } catch {}

  // --- navigator.languages ---------------------------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get() { return ['en-US', 'en']; },
      configurable: true
    });
  } catch {}

  // --- navigator.language (singular) -----------------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'language', {
      get() { return 'en-US'; },
      configurable: true
    });
  } catch {}

  // --- navigator.platform -----------------------------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get() { return 'Win32'; },
      configurable: true
    });
  } catch {}

  // --- navigator.hardwareConcurrency ------------------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get() { return 8; },
      configurable: true
    });
  } catch {}

  // --- navigator.deviceMemory (Chrome-only) ----------------------------------
  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      get() { return 8; },
      configurable: true
    });
  } catch {}

  // --- WebGL UNMASKED_RENDERER / VENDOR --------------------------------------
  const FAKE_GPU = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const FAKE_VENDOR = 'Google Inc. (NVIDIA)';
  for (const Ctx of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    try {
      const origGetParameter = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function (p) {
        // WEBGL_debug_renderer_info constants
        if (p === 0x9246) return FAKE_GPU;   // UNMASKED_RENDERER_WEBGL
        if (p === 0x9245) return FAKE_VENDOR; // UNMASKED_VENDOR_WEBGL
        return origGetParameter.call(this, p);
      };
    } catch {}
  }

  // --- AudioContext: add imperceptible noise to defeat float hashing --------
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (channel) {
      const data = origGetChannelData.call(this, channel);
      // Add deterministic tiny noise (seeded by channel index) — undetectable
      // to human ears but breaks exact float fingerprint hashes.
      for (let i = 0; i < data.length; i++) {
        data[i] += Math.sin(i * 0.0001 + channel) * 1e-7;
      }
      return data;
    };
  } catch {}

  // --- AudioContext sampleRate (some detectors check for unusual rates) ------
  try {
    const origSampleRate = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'sampleRate');
    if (origSampleRate?.get) {
      Object.defineProperty(BaseAudioContext.prototype, 'sampleRate', {
        get() { return 48000; },
        configurable: true
      });
    }
  } catch {}
})();
