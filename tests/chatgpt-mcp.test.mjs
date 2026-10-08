import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createChatGPTBridge } from '../netlify/lib/chatgpt-bridge.js';
import { createChatGPTMCP } from '../netlify/lib/chatgpt-mcp.js';
import { WORKFLOW } from '../netlify/lib/documentary-workflow.js';

const endpoint = 'https://craftush.test/api/chatgpt-mcp';
async function fixture() {
  const records = new Map(), store = { get: async k => structuredClone(records.get(k) ?? null), setJSON: async (k,v) => records.set(k,structuredClone(v)) };
  const bridge = createChatGPTBridge({ openStore: () => store, readSettings: async () => ({ runwareKey: 'never-read-or-return-this' }),
    teamCodeOk: async () => true, dashboardView: () => ({ cards: { documentary: { enabled: true } } }),
    json: (v,s=200) => Response.json(v,{status:s}), fail: (message,status) => Response.json({ errors:[{message}] },{status}) });
  const connected = await bridge(new Request('https://craftush.test/api/chatgpt-bridge',{method:'POST',headers:{origin:'https://craftush.test'},body:JSON.stringify({action:'create',idea:'Follow a mountain stream.'})}));
  const token = (await connected.json()).projectToken, handler = createChatGPTMCP(bridge);
  const client = new Client({name:'verification-client',version:'1.0.0'});
  const transport = new StreamableHTTPClientTransport(new URL(endpoint),{fetch:(url,init)=>handler(new Request(url,init))});
  await client.connect(transport);
  const call = async args => client.callTool({name:'craftush_project',arguments:{projectToken:token,...args}});
  return {handler,client,call,token,records};
}
const output = response => JSON.parse(response.content[0].text);

test('official MCP client initializes, discovers typed tools and retrieves key-free workflow', async () => {
  const f=await fixture();
  try {
    const {tools}=await f.client.listTools(); assert.deepEqual(tools.map(t=>t.name),['craftush_workflow','craftush_project']);
    assert.equal(tools[0].annotations.readOnlyHint,true); assert.equal(tools[1].annotations.readOnlyHint,false);
    assert.deepEqual(tools[1].inputSchema.properties.action.enum,['read','prepare','record']);
    const workflow=await f.client.callTool({name:'craftush_workflow',arguments:{}}), data=output(workflow);
    assert.equal(data.connection.keyRequired,false); assert.equal(data.runwareServer,'https://mcp.runware.ai');
    assert(!JSON.stringify(workflow).includes('never-read-or-return-this'));
  } finally {await f.client.close();}
});
test('real protocol preserves exact tasks, UUIDs and pending state through the bridge', async () => {
  const f=await fixture();
  try {
    const prepared=output(await f.call({action:'prepare'})); assert.equal(prepared.submissionRequired,true);
    assert.deepEqual(prepared.request[0].settings,WORKFLOW.master.settings); assert.equal(prepared.request[0].model,WORKFLOW.master.model);
    const pending=output(await f.call({action:'record',taskUUID:prepared.taskUUID,result:{taskUUID:prepared.taskUUID,status:'processing'}}));
    assert.equal(pending.masterReady,false); assert.equal(pending.taskStatus,'processing');
    const resumed=output(await f.call({action:'prepare'})); assert.equal(resumed.taskUUID,prepared.taskUUID); assert.equal(resumed.submissionRequired,false);
    assert.equal(resumed.request,undefined); assert.equal((await f.call({action:'prepare',retry:true})).isError,true);
  } finally {await f.client.close();}
});
test('completed provider text advances only the matching project and is reused', async () => {
  const f=await fixture();
  try {
    const plan={glossary:'Consistent Hindi pronunciation.',subject_sheet:'Mountain stream.',continuity_sheet:'Morning light.',...Object.fromEntries(Array.from({length:13},(_,i)=>['scene'+(i+1),'Narration: पानी यहाँ तक कैसे पहुँचा? Shot: Mountain stream. Sound: Water.']))};
    const task=output(await f.call({action:'prepare'})), args={action:'record',taskUUID:task.taskUUID,result:{taskUUID:task.taskUUID,text:JSON.stringify(plan),cost:.2}};
    assert.equal(output(await f.call(args)).masterReady,true);
    assert.equal(output(await f.call(args)).recorded,false);
    const state=output(await f.call({action:'read'})); assert.deepEqual(state.next,{kind:'director',scene:1});
    const scene=output(await f.call({action:'prepare'})); assert.equal(scene.request[0].model,WORKFLOW.director.model);
    assert(scene.request[0].messages[0].content.startsWith(JSON.stringify(plan)));
    assert.equal((await f.call({...args,projectToken:'0'.repeat(64)})).isError,true);
  } finally {await f.client.close();}
});
test('MCP cannot create, revoke or read full projects and rejects credential arguments', async () => {
  const f=await fixture();
  try {
    for(const action of ['create','revoke','project']) assert.equal((await f.call({action})).isError,true);
    assert.equal((await f.call({action:'read',apiKey:'do-not-store'})).isError,true);
    assert.equal((await f.client.callTool({name:'craftush_workflow',arguments:{secret:'do-not-store'}})).isError,true);
    assert(!JSON.stringify([...f.records.values()]).includes('do-not-store'));
  } finally {await f.client.close();}
});
test('transport rejects auth leakage, foreign browser origins, oversized bodies and batch requests', async () => {
  const f=await fixture();
  try {
    const post=(body,headers={})=>f.handler(new Request(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body}));
    assert.equal((await post('{}',{authorization:'Bearer do-not-send'})).status,400);
    assert.equal((await post('{}',{origin:'https://foreign.test'})).status,403);
    assert.equal((await post('[')).status,400); assert.equal((await post('[]')).status,400);
    assert.equal((await post('x'.repeat(95001))).status,413);
    assert.equal((await f.handler(new Request(endpoint))).status,405);
    const response=await post(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),{origin:'https://chatgpt.com'});
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert((await response.json()).result.tools.length===2);
  } finally {await f.client.close();}
});
