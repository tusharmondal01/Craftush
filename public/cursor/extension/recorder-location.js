/* Shared between the extension worker and its isolated content script. */
(() => {
  const localOrigins = new Set(['http://localhost:4173', 'http://127.0.0.1:4173']);
  const hostedOrigin = 'https://tusharmondal01.github.io', hostedPath = '/Craftush/cursor';
  globalThis.CursorStudioRecorderLocation = Object.freeze({
    isRecorderURL(value) {
      try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        return localOrigins.has(url.origin) || (url.origin === hostedOrigin &&
          (url.pathname === hostedPath || url.pathname.startsWith(hostedPath + '/')));
      } catch { return false; }
    },
  });
})();
