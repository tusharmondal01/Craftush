import { writeFile } from 'node:fs/promises';
import { CHATGPT_WORKFLOW } from '../netlify/lib/chatgpt-workflow.js';
await writeFile(new URL('../public/chatgpt/workflow-instructions.txt', import.meta.url), CHATGPT_WORKFLOW);
console.log('ChatGPT connection instructions prepared.');
