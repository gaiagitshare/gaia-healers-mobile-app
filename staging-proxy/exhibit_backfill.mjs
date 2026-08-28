// One-shot historical back-fill: capture every completed "Orlando In-Person Exhibit"
// (= ELEVATE) funnel buyer as an ELEVATE attendee via the production reconcile path.
// Idempotent + rank-guarded. GA-CONF (tier7: $297/$97) processed before GA (tier8: $99)
// so a multi-purchase buyer keeps their highest tier (base mappings only set-if-unset).
import fs from 'fs';
const env={}; for(const l of fs.readFileSync('/root/gaia-staging-proxy/.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim();}
const base=(env.GHL_API_BASE_URL||'').replace(/\/+$/,''), token=(env.GHL_API_TOKEN||'').trim(), loc=(env.GHL_LOCATION_ID||'').trim(), version=(env.GHL_API_VERSION||'2021-07-28').trim();
const EM=(env.EVENT_MANAGER_BASE_URL||'').replace(/\/+$/,''); const SVC=(env.IDENTITY_SERVICE_TOKEN||'').trim();
const GH={Accept:'application/json',Authorization:`Bearer ${token}`,Version:version};
const L=encodeURIComponent(loc); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function gget(p,tries=6){ for(let i=0;i<tries;i++){ try{ const r=await fetch(base+p,{headers:GH}); if(r.status===429||r.status>=500){await sleep(600*(i+1));continue;} if(!r.ok)return{__status:r.status}; return await r.json(); }catch(e){ await sleep(500*(i+1)); } } return {__failed:true}; }
const TIER={99:8,297:7,97:7};
(async()=>{
  let offset=0,total=Infinity; const orders=[];
  while(offset<total){ const j=await gget(`/payments/orders?altId=${L}&altType=location&limit=100&offset=${offset}`);
    if(typeof j.totalCount==='number')total=j.totalCount; const b=(j.data||[]); if(!b.length)break;
    for(const o of b){ const sn=o.sourceName||''; const amt=Math.round(Number(o.amount||0));
      if((o.status||o.paymentStatus)!=='completed')continue;
      if(!/Exhibit/i.test(sn))continue;
      if(!(amt in TIER))continue;
      orders.push({oid:o._id, email:(o.contactEmail||'').toLowerCase(), name:o.contactName||'', contact:o.contactId||'', amt}); }
    offset+=b.length; if(b.length<100)break; }
  orders.sort((a,b)=> TIER[a.amt]===TIER[b.amt]?0:(TIER[a.amt]<TIER[b.amt]?-1:1)); // tier7 before tier8
  let created=0,updated=0,blocked=0,failed=0,noemail=0; const oids=[];
  const byAmt={99:0,297:0,97:0};
  for(const t of orders){ oids.push(t.oid); byAmt[t.amt]++;
    if(!t.email||!t.email.includes('@')){noemail++;continue;}
    const parts=t.name.trim().split(/\s+/); const fn=parts.shift()||''; const ln=parts.join(' ');
    try{ const r=await fetch(EM+'/identity/reconcile-attendee',{method:'POST',headers:{Authorization:`Bearer ${SVC}`,'Content-Type':'application/json'},
      body:JSON.stringify({event_id:1,email:t.email,ticket_type_id:TIER[t.amt],first_name:fn,last_name:ln,phone:'',contact_id:t.contact,order_id:t.oid})});
      const j=await r.json();
      if(j.blocked)blocked++; else if(j.created)created++; else if(j.ok)updated++; else failed++;
    }catch(e){failed++;} }
  fs.writeFileSync('/tmp/exhibit_backfill_oids.json',JSON.stringify([...new Set(oids)]));
  console.log(`orders_matched=${orders.length} byAmount=${JSON.stringify(byAmt)}`);
  console.log(`BACKFILL created=${created} updated=${updated} blocked=${blocked} noemail=${noemail} failed=${failed}`);
})();
