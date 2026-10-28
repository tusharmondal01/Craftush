import {openStore,readSettings,teamCodeOk,dashboardView,fail} from '../lib/shared.js';
import {createBatchImageMedia} from '../lib/batch-image-media.js';
export default createBatchImageMedia({openStore,readSettings,teamCodeOk,dashboardView,fail,fetch:(...args)=>fetch(...args)});
export const config={path:'/api/batch-image-media'};
