(() => {
  const isRecorder = CursorStudioRecorderLocation.isRecorderURL(location.href);
  let recorderNonce = null;
  let enabled = false;
  let lastMove = -Infinity;
  let requestGeneration = 0;

  function runtimeMessage(message) {
    return chrome.runtime.sendMessage(message).catch(() => ({ ok: false }));
  }
  function postRecorder(message) {
    window.postMessage(message, location.origin);
  }
  function reportReady() {
    if (isRecorder) postRecorder({ type: "CURSOR_STUDIO_EXTENSION_READY", version: "1.0.1" });
  }
  function pointer(event) {
    if (!enabled || !event.isTrusted) return;
    const click = event.type === "pointerdown";
    const now = performance.now();
    if (!click && now - lastMove < 1000 / 30) return;
    if (!click) lastMove = now;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!width || !height) return;
    void runtimeMessage({
      type: "POINTER", x: Math.max(0, Math.min(1, event.clientX / width)),
      y: Math.max(0, Math.min(1, event.clientY / height)), click,
      timestamp: Date.now(), viewportWidth: width, viewportHeight: height,
      screenX: event.screenX, screenY: event.screenY
    });
  }
  function setTracking(value) {
    enabled = Boolean(value) && !isRecorder;
    window.removeEventListener("pointermove", pointer, true);
    window.removeEventListener("pointerdown", pointer, true);
    lastMove = -Infinity;
    if (enabled) {
      window.addEventListener("pointermove", pointer, { capture: true, passive: true });
      window.addEventListener("pointerdown", pointer, { capture: true, passive: true });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
    if (message.type === "TRACKING_STATE") {
      requestGeneration += 1;
      setTracking(message.enabled);
      respond({ ok: true });
    }
    if (isRecorder && recorderNonce && message.nonce === recorderNonce &&
        (message.type === "CURSOR_STUDIO_POINTER" || message.type === "CURSOR_STUDIO_TRACKER_STATUS")) {
      postRecorder(message);
      if (message.type === "CURSOR_STUDIO_TRACKER_STATUS" && message.active === false) recorderNonce = null;
      respond({ ok: true });
    }
  });

  if (isRecorder) {
    window.addEventListener("message", event => {
      if (event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
      const message = event.data;
      if (message.type === "CURSOR_STUDIO_EXTENSION_PING") {
        reportReady();
      } else if (message.type === "CURSOR_STUDIO_START_TRACKING" &&
                 typeof message.nonce === "string" && message.nonce.length >= 24 && message.nonce.length <= 256) {
        recorderNonce = message.nonce;
        void runtimeMessage({ type: "START", nonce: message.nonce }).then(response => {
          if (!response.ok && recorderNonce === message.nonce) {
            postRecorder({ type: "CURSOR_STUDIO_TRACKER_STATUS", nonce: message.nonce,
              active: false, targetTabId: null, targetTitle: "", error: "Could not start the companion tracker." });
            recorderNonce = null;
          }
        });
      } else if (message.type === "CURSOR_STUDIO_STOP_TRACKING" && message.nonce === recorderNonce) {
        void runtimeMessage({ type: "STOP", nonce: recorderNonce });
      }
    });
    reportReady();
    document.addEventListener("DOMContentLoaded", reportReady, { once: true });
    window.addEventListener("pagehide", () => {
      if (recorderNonce) void runtimeMessage({ type: "STOP", nonce: recorderNonce });
    });
  } else {
    const generation = requestGeneration;
    void runtimeMessage({ type: "GET_TRACKING" }).then(response => {
      if (generation === requestGeneration) setTracking(response.enabled);
    });
  }
})();
