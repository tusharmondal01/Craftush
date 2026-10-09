import { openStore, readSettings, activeKey, teamCodeOk, dashboardView, json, fail, RUNWARE_URL } from '../lib/shared.js';
import { createDocumentaryHandler } from '../lib/documentary-api.js';
import { limitRunwareTasks } from '../lib/runtime-context.js';

export default createDocumentaryHandler({ openStore, readSettings, activeKey, teamCodeOk, dashboardView, json, fail, limitRunwareTasks, fetch: (...args) => fetch(...args), runwareURL: RUNWARE_URL });
export const config = { path: '/api/documentary' };

