// READ-ONLY entitlement audit — build authoritative GHL product inventory with
// real completed-order attribution (product -> funnels/sources, counts, recurring).
import fs from 'fs';
const env={}; for(const l of fs.readFileSync('/root/gaia-staging-proxy/.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim();}
const base=(env.GHL_API_BASE_URL||'').replace(/\/+$/,''), token=(env.GHL_API_TOKEN||'').trim(), loc=(env.GHL_LOCATION_ID||'').trim(), version=(env.GHL_API_VERSION||'2021-07-28').trim();
const GH={Accept:'application/json',Authorization:`Bearer ${token}`,Version:version};
const L=encodeURIComponent(loc); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gget(p,tries=6){ for(let i=0;i<tries;i++){ try{ const r=await fetch(base+p,{headers:GH}); if(r.status===429||r.status>=500){await sleep(600*(i+1));continue;} if(!r.ok)return{__status:r.status}; return await r.json(); }catch(e){ await sleep(500*(i+1)); } } return {__failed:true}; }
(async()=>{
  // 1) full product catalogue
  const prod={}; let po=0,pt=Infinity;
  while(po<pt){ const j=await gget(`/products?locationId=${L}&limit=100&offset=${po}`); if(typeof j.total==='number')pt=j.total; else if(typeof j.totalCount==='number')pt=j.totalCount; const b=(j.products||j.data||[]); if(!b.length)break;
    for(const p of b){ prod[p._id]={name:p.name,type:p.productType,store:!!p.availableInStore,created:(p.createdAt||'').slice(0,10),prices:[],recurring:false}; }
    po+=b.length; if(b.length<100)break; }
  // prices per product (also reveals recurring)
  for(const id of Object.keys(prod)){ const j=await gget(`/products/${id}/price?locationId=${L}&limit=20`); const ps=(j.prices||[]); for(const pr of ps){ prod[id].prices.push({id:pr._id,amount:pr.amount,type:pr.type}); if((pr.type||'').toLowerCase()==='recurring'||pr.recurring)prod[id].recurring=true; } await sleep(30); }
  // 2) all completed orders (list) -> ids + source + amount
  let oo=0,ot=Infinity; const ords=[];
  while(oo<ot){ const j=await gget(`/payments/orders?altId=${L}&altType=location&limit=100&offset=${oo}`); if(typeof j.totalCount==='number')ot=j.totalCount; const b=(j.data||[]); if(!b.length)break;
    for(const o of b){ if((o.status||o.paymentStatus)==='completed') ords.push({id:o._id,src:o.sourceName||'(none)',srcType:o.sourceType||'',amt:Math.round(Number(o.amount||0)),date:(o.createdAt||'').slice(0,10)}); }
    oo+=b.length; if(b.length<100)break; }
  // 3) details -> product attribution (retry to zero)
  let todo=ords.map(o=>o.id); const det=new Map(); let round=0;
  while(todo.length && round<5){ round++; const fail=[];
    for(let i=0;i<todo.length;i+=6){ const ids=todo.slice(i,i+6); const ds=await Promise.all(ids.map(id=>gget(`/payments/orders/${id}?altId=${L}&altType=location`)));
      ds.forEach((d,k)=>{ if(!d||d.__failed||d.__status) fail.push(ids[k]); else det.set(ids[k],d); }); await sleep(90); }
    todo=fail; }
  const ordSrc=new Map(ords.map(o=>[o.id,o]));
  // matrix product -> counts, sources, amounts
  const M={};
  for(const [id,d] of det){ const o=ordSrc.get(id)||{}; for(const it of (d.items||[])){ const pid=(it.product&&it.product._id)||it.productId; if(!pid)continue; M[pid]=M[pid]||{count:0,sources:{},amounts:{}}; M[pid].count++; M[pid].sources[o.src]=(M[pid].sources[o.src]||0)+1; const am=(it.price&&it.price.amount)!=null?it.price.amount:o.amt; M[pid].amounts[am]=(M[pid].amounts[am]||0)+1; } }
  // merge + emit
  const rows=[];
  for(const [id,p] of Object.entries(prod)){ const m=M[id]||{count:0,sources:{},amounts:{}}; rows.push({id,name:p.name,type:p.type,store:p.store,recurring:p.recurring,created:p.created,prices:p.prices,orders:m.count,sources:m.sources,amounts:m.amounts}); }
  // products that had sales but weren't in catalogue (deleted/archived)
  for(const [id,m] of Object.entries(M)){ if(!prod[id]){ const anyName=[...det.values()].flatMap(d=>d.items||[]).find(it=>((it.product&&it.product._id)||it.productId)===id); rows.push({id,name:(anyName&&anyName.product&&anyName.product.name)||'(not in catalogue)',type:'?',store:'?',recurring:'?',created:'?',prices:[],orders:m.count,sources:m.sources,amounts:m.amounts,archived:true}); } }
  rows.sort((a,b)=>b.orders-a.orders);
  fs.writeFileSync('/tmp/ghl_inventory.json',JSON.stringify(rows,null,1));
  console.log(`catalogue_products=${Object.keys(prod).length} completed_orders=${ords.length} details_fetched=${det.size} unfetched=${todo.length} products_with_sales=${Object.keys(M).length}`);
  console.log('--- products WITH completed sales (id | orders | type | recurring | name | sources) ---');
  for(const r of rows.filter(r=>r.orders>0)){ console.log(`${r.id} | ${String(r.orders).padStart(4)} | ${String(r.type).padEnd(12)} | ${r.recurring?'REC':'one'} | ${String(r.name).slice(0,52)} | ${Object.keys(r.sources).slice(0,3).join(' , ')}`); }
})();
