/* Only the allowlisted recorder can start a session. The popup selects one target. */
importScripts('recorder-location.js');
const { isRecorderURL } = CursorStudioRecorderLocation;
const SESSION_KEY = "cursorStudioSession";
let session = null;
let stateReady = chrome.storage.session.get(SESSION_KEY).then(value => {
  session = value[SESSION_KEY] || null;
});
let mutationQueue = Promise.resolve();

function originOf(url) {
  try { return new URL(url).origin; } catch { return ""; }
}
function validNonce(nonce) {
  return typeof nonce === "string" && nonce.length >= 24 && nonce.length <= 256;
}
function recorderSender(sender) {
  return sender.frameId === 0 && Number.isInteger(sender.tab?.id) &&
    isRecorderURL(sender.url);
}
function popupSender(sender) {
  return !sender.tab && sender.url === chrome.runtime.getURL("popup.html");
}
async function sendTab(tabId, message) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    return true;
  } catch { return false; /* Closed/reloading tab. */ }
}
function publicStatus(value = session) {
  return {
    active: Boolean(value),
    targetTabId: value?.targetTabId ?? null,
    targetTitle: value?.targetTitle || "",
    targetUrl: value?.targetUrl || ""
  };
}
async function saveSession() {
  if (session) await chrome.storage.session.set({ [SESSION_KEY]: session });
  else await chrome.storage.session.remove(SESSION_KEY);
}
async function notifyRecorder() {
  if (!session) return;
  await sendTab(session.recorderTabId, {
    type: "CURSOR_STUDIO_TRACKER_STATUS", nonce: session.nonce, ...publicStatus()
  });
}
async function stopSession() {
  const previous = session;
  session = null;
  await saveSession();
  if (!previous) return;
  await sendTab(previous.targetTabId, { type: "TRACKING_STATE", enabled: false });
  await sendTab(previous.recorderTabId, {
    type: "CURSOR_STUDIO_TRACKER_STATUS", nonce: previous.nonce,
    active: false, targetTabId: null, targetTitle: "", targetUrl: ""
  });
}
function serialize(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function handleMessage(message, sender) {
  await stateReady;
  if (!message || typeof message !== "object") return { ok: false };
  if (message.type === "START") {
    if (!recorderSender(sender) || !validNonce(message.nonce)) return { ok: false };
    return serialize(async () => {
      if (session?.recorderTabId === sender.tab.id && session.nonce === message.nonce) {
        await notifyRecorder();
        return { ok: true, ...publicStatus() };
      }
      await stopSession();
      session = {
        recorderTabId: sender.tab.id, recorderOrigin: originOf(sender.url),
        nonce: message.nonce, targetTabId: null, targetTitle: "", targetUrl: ""
      };
      await saveSession();
      await notifyRecorder();
      return { ok: true, ...publicStatus() };
    });
  }
  if (message.type === "STOP") {
    if (!recorderSender(sender)) return { ok: false };
    return serialize(async () => {
      if (!session || session.recorderTabId !== sender.tab.id || session.nonce !== message.nonce) {
        return { ok: false };
      }
      await stopSession();
      return { ok: true };
    });
  }
  if (message.type === "GET_SESSION") {
    return popupSender(sender) ? { ok: true, ...publicStatus() } : { ok: false };
  }
  if (message.type === "GET_TRACKING") {
    return { ok: true, enabled: Boolean(session && sender.frameId === 0 &&
      sender.tab?.id === session.targetTabId && sender.tab.id !== session.recorderTabId) };
  }
  if (message.type === "TARGET_TAB") {
    if (!popupSender(sender)) return { ok: false };
    return serialize(async () => {
      if (!session) return { ok: false, error: "Start a recording in Cursor Studio first." };
      // Select the actual active tab, not an arbitrary ID supplied in a message.
      const [target] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!target || target.id === session.recorderTabId ||
          !/^https?:\/\//.test(target.url || "") || isRecorderURL(target.url)) {
        return { ok: false, error: "Open the web page you are sharing, then choose Track this tab." };
      }
      await sendTab(session.targetTabId, { type: "TRACKING_STATE", enabled: false });
      session.targetTabId = target.id;
      session.targetTitle = target.title || "Selected tab";
      session.targetUrl = target.url || "";
      const connected = await sendTab(target.id, { type: "TRACKING_STATE", enabled: true });
      if (!connected) {
        session.targetTabId = null;
        session.targetTitle = "";
        session.targetUrl = "";
        await saveSession();
        await notifyRecorder();
        return { ok: false, error: "Reload this web page, then choose Track this tab again." };
      }
      await saveSession();
      await notifyRecorder();
      return { ok: true, ...publicStatus() };
    });
  }
  if (message.type === "CLEAR_TARGET") {
    if (!popupSender(sender)) return { ok: false };
    return serialize(async () => {
      if (!session) return { ok: true, ...publicStatus() };
      await sendTab(session.targetTabId, { type: "TRACKING_STATE", enabled: false });
      session.targetTabId = null;
      session.targetTitle = "";
      session.targetUrl = "";
      await saveSession();
      await notifyRecorder();
      return { ok: true, ...publicStatus() };
    });
  }
  if (message.type === "POINTER") {
    const active = session;
    if (!active || sender.frameId !== 0 || sender.tab?.id !== active.targetTabId) return { ok: false };
    if (![message.x, message.y, message.viewportWidth, message.viewportHeight, message.timestamp].every(Number.isFinite) ||
        message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1 ||
        message.viewportWidth <= 0 || message.viewportHeight <= 0 || typeof message.click !== "boolean") {
      return { ok: false };
    }
    await sendTab(active.recorderTabId, {
      type: "CURSOR_STUDIO_POINTER", nonce: active.nonce,
      x: message.x, y: message.y, click: message.click, timestamp: message.timestamp,
      viewportWidth: message.viewportWidth, viewportHeight: message.viewportHeight,
      screenX: Number.isFinite(message.screenX) ? message.screenX : null,
      screenY: Number.isFinite(message.screenY) ? message.screenY : null,
      url: sender.url || "", title: sender.tab.title || ""
    });
    return { ok: true };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handleMessage(message, sender).then(respond).catch(() => respond({ ok: false, error: "The tracker could not connect. Reload the page and try again." }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  serialize(async () => {
    await stateReady;
    if (!session) return;
    if (session.recorderTabId === tabId) await stopSession();
    else if (session.targetTabId === tabId) {
      session.targetTabId = null;
      session.targetTitle = "";
      session.targetUrl = "";
      await saveSession();
      await notifyRecorder();
    }
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  serialize(async () => {
    await stateReady;
    if (!session) return;
    if (session.recorderTabId === tabId && change.status === "loading") {
      await stopSession();
    } else if (session.targetTabId === tabId && (change.title || change.url)) {
      session.targetTitle = tab.title || session.targetTitle;
      session.targetUrl = tab.url || session.targetUrl;
      await saveSession();
      await notifyRecorder();
    }
  }).catch(() => {});
});
