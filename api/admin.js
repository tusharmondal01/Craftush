// Vercel function for /api/admin. It reuses the Netlify handler in netlify/edge-functions/admin.js,
// so both hosts run exactly the same code.
import rawHandler from "../netlify/edge-functions/admin.js";

import { withStorageErrors } from "../netlify/lib/storage-errors.js";
const handler = withStorageErrors(rawHandler);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const OPTIONS = handler;
