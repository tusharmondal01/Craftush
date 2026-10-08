import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CHATGPT_WORKFLOW } from './chatgpt-workflow.js';

const projectSchema = {
  type: 'object', required: ['action', 'projectToken'], additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['read', 'prepare', 'record'] },
    projectToken: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'The temporary Craftush project code supplied by the user; never a provider key.' },
    kind: { type: 'string', enum: ['master', 'director', 'video'] },
    scene: { type: 'integer', minimum: 1, maximum: 13 },
    retry: { type: 'boolean', description: 'True only for a confirmed failed task when the user explicitly requests a retry.' },
    taskUUID: { type: 'string', format: 'uuid' },
    result: { type: 'object', required: ['taskUUID'], additionalProperties: false, properties: {
      taskUUID: { type: 'string', format: 'uuid' }, text: { type: 'string', maxLength: 88000 },
      videoURL: { type: 'string', format: 'uri' }, finishReason: { type: 'string' },
      status: { type: 'string', enum: ['processing', 'submitted', 'prepared'] },
      cost: { type: 'number', minimum: 0 }, error: { type: 'string', maxLength: 600 },
    } },
  },
};
const tools = [
  { name: 'craftush_workflow', title: 'Craftush documentary instructions',
    description: 'Read the exact workflow and connection status before generating a Craftush documentary through the official Runware connection. No generation or provider credential is needed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: 'noauth' }], _meta: { securitySchemes: [{ type: 'noauth' }] } },
  { name: 'craftush_project', title: 'Craftush project handoff',
    description: 'Read one connected project, prepare its exact native Runware task, or record its matching result. Never sends generation to Runware. Requires the user’s temporary project code. Preserve task UUIDs and poll uncertain jobs before any new generation.',
    inputSchema: projectSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: 'noauth' }], _meta: { securitySchemes: [{ type: 'noauth' }] } },
];
const reply = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}) });

// Stateless MCP transport: every HTTP request receives its own server. Only
// project-scoped capability codes reach the bridge; provider auth is rejected.
export function createChatGPTMCP(bridge) {
  return async req => {
    if (req.headers.has('authorization')) return Response.json({ error: 'Craftush uses No authentication. Never send the Runware credential or OAuth token here.' }, { status: 400 });
    const origin = req.headers.get('origin');
    if (origin && origin !== new URL(req.url).origin && origin !== 'https://chatgpt.com') return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
    let body;
    try {
      const raw = await req.text();
      if (raw.length > 95000) return Response.json({ error: 'Request exceeds the project handoff limit.' }, { status: 413 });
      body = JSON.parse(raw);
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Invalid request');
    } catch { return Response.json({ error: 'A JSON-RPC request object is required.' }, { status: 400 }); }
    const server = new Server({ name: 'Craftush', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: CHATGPT_WORKFLOW });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async call => {
      const args = call.params.arguments || {};
      if (call.params.name === 'craftush_workflow') {
        if (Object.keys(args).length) return reply({ error: 'This tool takes no arguments or credentials.' }, true);
        const metadata = await bridge(new Request(new URL('/api/chatgpt-bridge', req.url)));
        return reply({ instructions: CHATGPT_WORKFLOW, connection: await metadata.json(),
          projectPage: 'https://craftush-v13-live.vercel.app/chatgpt/', runwareServer: 'https://mcp.runware.ai' }, !metadata.ok);
      }
      if (call.params.name !== 'craftush_project') return reply({ error: 'Unknown Craftush tool.' }, true);
      if (!['read', 'prepare', 'record'].includes(args.action)) return reply({ error: 'Use read, prepare or record. Create and end connections on the Craftush website.' }, true);
      const result = await bridge(new Request(new URL('/api/chatgpt-bridge', req.url), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args),
      }));
      return reply(await result.json(), !result.ok);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody: body });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } finally { await server.close(); }
  };
}
