import test from 'node:test';
import assert from 'node:assert/strict';
import { createTouchTracker, grayscale, findTouchCircles } from '../public/cursor/touch-detector.js';
import { buildTouchMotion, insertCameraMove } from '../public/cursor/touch-motion.js';
import { cameraAt, createCameraSampler, cropForCamera } from '../public/cursor/camera.js';

function frame({ width = 128, height = 224, background = 55, dot = null } = {}) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    let color = [background, background, background];
    if (x > 18 && x < 100 && y > 40 && y < 52) color = [130, 130, 130];
    if (Math.hypot(x - 23, y - 23) < 7) color = [235, 235, 235];
    if (Math.hypot(x - 85, y - 110) < 7) color = [25, 176, 143];
    if (dot) {
      const d = Math.hypot(x - dot.x, y - dot.y), radius = dot.radius ?? 7;
      if (d <= radius + 1) {
        const edge = Math.max(0, Math.min(1, radius + 1 - d));
        const ring = d > radius - 1 ? 145 : 240;
        color = color.map(value => value * (1 - edge * .82) + ring * edge * .82);
      }
    }
    pixels.set([...color, 255], p);
  }
  return pixels;
}

test('touch circle detection distinguishes a neutral touch dot from colored chart marks', () => {
  const rgba = frame({ dot: { x: 65, y: 157, radius: 7 } });
  const circles = findTouchCircles(grayscale(rgba, 128, 224), 128, 224);
  assert(circles.some(dot => Math.hypot(dot.x - 65, dot.y - 157) < 3), JSON.stringify(circles));
  assert(!circles.some(dot => Math.hypot(dot.x - 85, dot.y - 110) < 3));
});

test('static circular UI never starts an automatic touch gesture', () => {
  const tracker = createTouchTracker({ width: 128, height: 224 });
  for (let i = 0; i < 15; i++) tracker.push(frame(), i / 12);
  assert.equal(tracker.result().samples.length, 0);
});

test('appearance, drag and a later touch become distinct timestamped gestures', () => {
  const tracker = createTouchTracker({ width: 128, height: 224 });
  tracker.push(frame(), 0);
  for (let i = 1; i < 12; i++) tracker.push(frame({ dot: { x: 42 + i * 3, y: 160 - i, radius: 7 } }), i / 12);
  for (let i = 12; i < 18; i++) tracker.push(frame(), i / 12);
  for (let i = 18; i < 25; i++) tracker.push(frame({ dot: { x: 45, y: 85, radius: 7 } }), i / 12);
  const { samples } = tracker.result();
  assert(samples.length >= 14, JSON.stringify(samples));
  assert.equal(new Set(samples.map(point => point.gesture)).size, 2);
  assert(samples.every(point => point.confidence >= .65));
  assert(samples.at(8).x > samples[0].x + .15);
});

test('a neutral touch remains detectable on a bright screen with its grey outline', () => {
  const tracker = createTouchTracker({ width: 128, height: 224 });
  tracker.push(frame({ background: 242 }), 0);
  for (let i = 1; i < 8; i++) tracker.push(frame({ background: 242, dot: { x: 50 + i, y: 170, radius: 7 } }), i / 12);
  assert(tracker.result().samples.length >= 5, JSON.stringify(tracker.result()));
});

function touches() {
  const samples=[];
  for(const [gesture,start,end,x,y,dx,dy] of [[1,1,2.2,.3,.37,0,0],[2,4,5.3,.2,.64,.5,-.1],[3,6,7,.8,.77,-.5,.04]]){
    for(let time=start;time<=end;time+=1/12){const p=(time-start)/(end-start);samples.push({time,x:x+dx*p,y:y+dy*p,confidence:.95,gesture});}
  }
  return samples;
}

test('automatic camera motion starts full, follows each drag and holds its zoom until a full-frame edit', () => {
  const events=buildTouchMotion(touches(),8);
  assert.equal(cameraAt(events,.5).zoom,1);
  assert(cameraAt(events,2.1).zoom>1.99);
  assert(cameraAt(events,3.2).zoom>1.99,'gaps do not automatically zoom out');
  assert(cameraAt(events,5.2).x>cameraAt(events,4.8).x);
  assert(cameraAt(events,7.9).zoom>1.99);
  assert(events.every(event=>event.time<8&&event.origin==='touch'&&event.curve==='follow'));
  assert.deepEqual(buildTouchMotion([{time:1,x:.5,y:.5,confidence:.2}],8),[]);
});

test('automatic paths have continuous velocity, bounded scale and identical seek and export poses', () => {
  const events=buildTouchMotion(touches(),8),sample=createCameraSampler(events);
  for(let time=0;time<8;time+=.031){
    assert.deepEqual(sample(time),cameraAt(events,time));
    const pose=sample(time);
    assert(pose.zoom>=1&&pose.zoom<=2.00001&&pose.x>=0&&pose.x<=1&&pose.y>=0&&pose.y<=1);
    const crop=cropForCamera(540,960,1080,1920,{...pose,fit:'contain'});
    assert(crop.sx>=0&&crop.sy>=0&&crop.sx+crop.cropW<=540.00001&&crop.sy+crop.cropH<=960.00001);
  }
  for(const event of events.slice(1,-1)){
    const h=.00001,at=sample(event.time),left=sample(event.time-h),right=sample(event.time+h);
    for(const key of ['x','y','zoom'])assert(Math.abs((at[key]-left[key])/h-(right[key]-at[key])/h)<.05,`${key} velocity at ${event.time}`);
  }
});

test('a full-frame shortcut overrides the current gesture, then following resumes gently at the next gesture', () => {
  const original=buildTouchMotion(touches(),8);
  const full={id:'full-view',time:2.5,duration:.8,x:.5,y:.5,zoom:1,kind:'Full frame'};
  const events=insertCameraMove(original,full,8);
  assert.deepEqual(cameraAt(events,2.5),cameraAt(original,2.5),'full frame starts from the current pose');
  assert.equal(cameraAt(events,3.5).zoom,1);
  assert.equal(cameraAt(events,4).zoom,1);
  assert(cameraAt(events,4.4).zoom>1&&cameraAt(events,4.4).zoom<2);
  assert(cameraAt(events,5.2).zoom>1.99);
  assert(events.some(event=>event.id==='full-view'));
  const midDrag={...full,id:'during-drag',time:4.7};
  const interrupted=insertCameraMove(original,midDrag,8);
  assert.deepEqual(cameraAt(interrupted,4.7),cameraAt(original,4.7),'a drag-to-full-frame edit starts at the exact visible pose');
  const last=insertCameraMove(events,{...full,id:'ending',time:7.1},8);
  assert.equal(cameraAt(last,7.95).zoom,1,'the final full view stays full without another touch');
});

test('out-of-order and duplicate analysis frames do not create duplicate touch samples', () => {
  const tracker=createTouchTracker({width:128,height:224});
  tracker.push(frame(),0);tracker.push(frame({dot:{x:70,y:150}}),.1);
  const before=tracker.result();
  tracker.push(frame({dot:{x:75,y:150}}),.1);tracker.push(frame({dot:{x:65,y:150}}),.05);
  assert.deepEqual(tracker.result(),before);
});
