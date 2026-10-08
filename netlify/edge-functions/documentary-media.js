import { openStore, readSettings, teamCodeOk, dashboardView, fail } from '../lib/shared.js';
import { createMediaHandler } from '../lib/documentary-media.js';
export default createMediaHandler({ openStore, readSettings, teamCodeOk, dashboardView, fail, fetch: (...args) => fetch(...args) });
export const config = { path: '/api/documentary-media' };
