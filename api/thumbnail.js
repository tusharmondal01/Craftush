// Vercel function for /api/thumbnail. It reuses the Netlify handler in netlify/edge-functions/thumbnail.js,
// so both hosts run exactly the same code.
import rawHandler from "../netlify/edge-functions/thumbnail.js";

import { withStorageErrors } from "../netlify/lib/storage-errors.js";
const handler = withStorageErrors(rawHandler);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const OPTIONS = handler;
