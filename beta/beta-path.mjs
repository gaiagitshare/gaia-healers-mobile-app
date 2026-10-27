// Same production rule engine; only workspace-local, non-clinical inputs.
import fs from 'node:fs';
const engine=process.env.BETA_PATH_ENGINE || (fs.existsSync(new URL('./staging-proxy/personal-path.js',import.meta.url))?'./staging-proxy/personal-path.js':'../staging-proxy/personal-path.js');
const {buildPath}=await import(engine);
import {signedIn} from './beta-access.mjs';
import {learningCatalog} from './beta-learning.mjs';
export function workspacePath(s) {
 if(!signedIn(s))return {items:[],also_recommended:[],caught_up:true};
 const courses=learningCatalog(s).map(c=>({id:c.key,title:c.title,accessible:c.included,started:!!((s.learningProgress?.[c.key]||[]).length||Object.keys(s.learningPositions?.[c.key]||{}).length),pct:c.lessons.length?(s.learningProgress?.[c.key]||[]).length/c.lessons.length*100:0}));
 return buildPath({courses,readings:{enabled:false},onboarding:{required:false}}, {state:s.pathState||{},now:s.now});
}
export function pathEvent(s,p) {
 if(!signedIn(s)||s.actor!=='member')throw Error('Sign in as the member to use your path.');
 if(!['recommendation_opened','recommendation_dismissed'].includes(p.event))throw Error('This action cannot mark a course or booking complete.');
 const item=workspacePath(s).items.find(i=>i.key===p.key);
 if(!item)throw Error('This action is not in your current path.');
 s.pathState??={};s.pathState[item.key]={state:p.event==='recommendation_opened'?'opened':'dismissed'};
 return s.pathState[item.key];
}
