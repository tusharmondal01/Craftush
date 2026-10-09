// Never expose private provider details or bypass authorization when settings cannot be read.
export class PrivateStorageError extends Error {
  constructor(cause) {
    const denied = /403|forbidden|access denied/i.test(String(cause?.message || ''));
    super(denied
      ? "Vercel has blocked access to the site's saved settings. The owner must check Vercel Storage usage limits and the store connection. Keep existing project and task IDs, then retry after access is restored."
      : "The site's saved settings storage is unavailable. Try again shortly; the owner should check Vercel Storage if it continues.");
    this.name = 'PrivateStorageError';
    this.code = denied ? 'STORAGE_ACCESS_DENIED' : 'STORAGE_UNAVAILABLE';
  }
}

export function storageErrorResponse(error) {
  if (!(error instanceof PrivateStorageError)) return null;
  return new Response(JSON.stringify({ errors: [{ code: error.code, message: error.message }] }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function withStorageErrors(handler) {
  return async (...args) => {
    try { return await handler(...args); }
    catch (error) {
      const response = storageErrorResponse(error);
      if (response) return response;
      throw error;
    }
  };
}
