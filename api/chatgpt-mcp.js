import bridge from '../netlify/edge-functions/chatgpt-bridge.js';
import { createChatGPTMCP } from '../netlify/lib/chatgpt-mcp.js';
export const POST = createChatGPTMCP(bridge);
export const GET = POST;
export const DELETE = POST;
