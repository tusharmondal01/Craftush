import { spawn } from 'node:child_process';
import { createTouchTracker } from '../public/cursor/touch-detector.js';
import { buildTouchMotion } from '../public/cursor/touch-motion.js';
import { cameraAt } from '../public/cursor/camera.js';

const width=384,height=682,fps=12,frameBytes=width*height*4;
function truth(time){if(time>=1&&time<=2.2)return{x:.30,y:.37};if(time>=3&&time<=4.3){const p=(time-3)/1.3;return{x:.20+.50*p,y:.64-.10*p};}if(time>=5.2&&time<=6.4){const p=(time-5.2)/1.2;return{x:.80-.50*p,y:.77+.04*p};}return null;}
async function inspect(file){
  const tracker=createTouchTracker({width,height});
  const process=spawn('ffmpeg',['-v','error','-i',file,'-an','-vf',`scale=${width}:${height},fps=${fps}`,'-pix_fmt','rgba','-f','rawvideo','-'],{stdio:['ignore','pipe','inherit']});
  const done=new Promise((resolve,reject)=>{process.on('error',reject);process.on('close',code=>code?reject(new Error('Decoding failed.')):resolve());});
  let pending=Buffer.alloc(0),frame=0;
  for await(const chunk of process.stdout){pending=Buffer.concat([pending,chunk]);while(pending.length>=frameBytes){tracker.push(new Uint8ClampedArray(pending.buffer,pending.byteOffset,frameBytes),frame/fps);pending=pending.subarray(frameBytes);frame++;}}
  await done;
  if(pending.length)throw new Error('Incomplete decoded frame.');
  return tracker.result();
}
const clean=await inspect('public/cursor/Examples/phone-demo-raw.mp4');
if(clean.frames<90)throw new Error('The no-dot sample was not fully decoded.');
if(clean.samples.length)throw new Error(`Clean recording produced ${clean.samples.length} false touch detections: ${JSON.stringify(clean.samples.slice(0,12))}`);
const result=await inspect('public/cursor/Examples/mobile-touch-demo.mp4');
const expected=Array.from({length:result.frames},(_,i)=>truth(i/fps)).filter(Boolean).length;
const matched=result.samples.filter(point=>{const target=truth(point.time);return target&&Math.hypot(point.x-target.x,point.y-target.y)<.025;});
const precision=matched.length/Math.max(1,result.samples.length),recall=matched.length/expected;
const motions=buildTouchMotion(result.samples,8);
if(precision<.95||recall<.85||new Set(result.samples.map(point=>point.gesture)).size!==3||!motions.length)throw new Error(JSON.stringify({precision,recall,frames:result.frames,samples:result.samples.filter(point=>{const target=truth(point.time);return !target||Math.hypot(point.x-target.x,point.y-target.y)>.025;}).slice(0,12),detected:result.samples.length,gestures:[...new Set(result.samples.map(point=>point.gesture))],motions:motions.length}));
if(cameraAt(motions,7).zoom<1.99)throw new Error('Automatic motion unexpectedly zoomed back out.');
console.log(JSON.stringify({cleanFalseDetections:clean.samples.length,frames:result.frames,detectedSamples:result.samples.length,precision,recall,gestures:3,cameraKeys:motions.length}));
