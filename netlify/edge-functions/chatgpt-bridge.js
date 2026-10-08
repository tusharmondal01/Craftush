import { openStore, readSettings, teamCodeOk, dashboardView, json, fail } from '../lib/shared.js';
import { createChatGPTBridge } from '../lib/chatgpt-bridge.js';
export default createChatGPTBridge({ openStore, readSettings, teamCodeOk, dashboardView, json, fail });
export const config = { path: '/api/chatgpt-bridge' };
