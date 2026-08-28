// READ-ONLY: build an authoritative per-order product cache for the B ($99) and
// D ($97) entitlement analyses. Fetches every completed order's line items.
import fs from 'fs';
const env={}; for(const l of fs.readFileSync('/root/gaia-staging-proxy/.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim();}
const base=(env.GHL_API_BASE_URL||'').replace(/\/+$/,''), token=(env.GHL_API_TOKEN||'').trim(), loc=(env.GHL_LOCATION_ID||'').trim(), version=(env.GHL_API_VERSION||'2021-07-28').trim();
const GH={Accept:'application/json',Authorization:`Bearer ${token}`,Version:version};
const L=encodeURIComponent(loc); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gget(p,tries=6){ for(let i=0;i<tries;i++){ try{ const r=await fetch(base+p,{headers:GH}); if(r.status===429||r.status>=500){await sleep(600*(i+1));continue;} if(!r.ok)return{__status:r.status}; return await r.json(); }catch(e){ await sleep(500*(i+1)); } } return {__failed:true}; }
(async()=>{
  let oo=0,ot=Infinity; const ids=[]; const meta=new Map();
  while(oo<ot){ const j=await gget(`/payments/orders?altId=${L}&altType=location&limit=100&offset=${oo}`); if(typeof j.totalCount==='number')ot=j.totalCount; const b=(j.data||[]); if(!b.length)break;
    for(const o of b){ if((o.status||o.paymentStatus)==='completed'){ ids.push(o._id); meta.set(o._id,{email:(o.contactEmail||'').toLowerCase(),contact:o.contactId||'',name:o.contactName||'',src:o.sourceName||'',amt:Math.round(Number(o.amount||0)),date:(o.createdAt||'').slice(0,19)}); } }
    oo+=b.length; if(b.length<100)break; }
  let todo=[...ids]; const out={}; let round=0;
  while(todo.length && round<5){ round++; const fail=[];
    for(let i=0;i<todo.length;i+=6){ const chunk=todo.slice(i,i+6); const ds=await Promise.all(chunk.map(id=>gget(`/payments/orders/${id}?altId=${L}&altType=location`)));
      ds.forEach((d,k)=>{ const id=chunk[k]; if(!d||d.__failed||d.__status){fail.push(id);return;} const m=meta.get(id)||{}; out[id]={...m, items:(d.items||[]).map(it=>({pid:(it.product&&it.product._id)||it.productId,name:(it.product&&it.product.name)||'',amount:(it.price&&it.price.amount)}))}; }); await sleep(90); }
    todo=fail; }
  fs.writeFileSync('/tmp/orders_detail.json',JSON.stringify(out));
  console.log(`cached=${Object.keys(out).length} unfetched=${todo.length}`);
})();
