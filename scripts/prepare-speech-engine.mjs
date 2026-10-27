import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';

// Ship the pinned browser engine and its matching WASM together. Narration
// must not depend on a third-party CDN to start its worker or WASM runtime.
const source=new URL('../node_modules/@huggingface/transformers/',import.meta.url);
const target=new URL('../public/documentary/vendor/speech-3.8.1/',import.meta.url);
if(JSON.parse(await readFile(new URL('package.json',source),'utf8')).version!=='3.8.1')throw new Error('Expected speech engine 3.8.1.');
const hashes={
 'transformers.min.js':'aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa',
 'ort-wasm-simd-threaded.jsep.mjs':'08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9',
 'ort-wasm-simd-threaded.jsep.wasm':'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39'
};
const verified=[];
for(const [name,hash] of Object.entries(hashes)){
 const bytes=await readFile(new URL('dist/'+name,source));
 if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Speech engine checksum mismatch: '+name);
 verified.push([name,bytes]);
}
await mkdir(target,{recursive:true});
for(const [name,bytes] of verified)await writeFile(new URL(name,target),bytes);
await writeFile(new URL('LICENSE.txt',target),await readFile(new URL('LICENSE',source)));
console.log('Speech engine ready: Transformers.js 3.8.1 and matching WASM, checksums verified.');
