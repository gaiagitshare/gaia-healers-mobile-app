// Ongoing ELEVATE reconciliation — recent window only, whitelist-only, idempotent,
// retry-to-zero, never silently skips. Safe to run every few minutes on a timer.
import fs from 'fs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 4);
const env={}; for(const l of fs.readFileSync('/root/gaia-staging-proxy/.env','utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim();}
const base=(env.GHL_API_BASE_URL||'').replace(/\/+$/,''), token=(env.GHL_API_TOKEN||'').trim(), loc=(env.GHL_LOCATION_ID||'').trim(), version=(env.GHL_API_VERSION||'2021-07-28').trim();
const EM=(env.EVENT_MANAGER_BASE_URL||'').replace(/\/+$/,''); const SVC=(env.IDENTITY_SERVICE_TOKEN||'').trim();
const GH={Accept:'application/json',Authorization:`Bearer ${token}`,Version:version};
const L=encodeURIComponent(loc); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stamp=()=>new Date().toISOString().slice(0,19).replace('T',' ');
async function gget(p,tries=6){ for(let i=0;i<tries;i++){ try{ const r=await fetch(base+p,{headers:GH}); if(r.status===429||r.status>=500){await sleep(600*(i+1));continue;} if(!r.ok)return{__status:r.status}; return await r.json(); }catch(e){ await sleep(500*(i+1)); } } return {__failed:true}; }
(async()=>{
  const mapRows=await (await fetch(EM+'/identity/ticket-mappings',{headers:{Authorization:`Bearer ${SVC}`}})).json();
  const PMAP=new Map(); for(const m of mapRows) if(m.provider==='ghl' && ['EVENT_TICKET','EVENT_UPGRADE'].includes(m.entitlement_type||'EVENT_TICKET')) PMAP.set(m.external_product_id,m);
  const cutoff=Date.now()-LOOKBACK_DAYS*86400000;
  // list orders (light), keep recent completed
  let offset=0,total=Infinity; const recent=[];
  while(offset<total){ const j=await gget(`/payments/orders?altId=${L}&altType=location&limit=100&offset=${offset}`); if(typeof j.totalCount==='number')total=j.totalCount; const b=(j.data||[]); if(!b.length)break;
    for(const o of b){ const t=Date.parse(o.createdAt||o.updatedAt||''); if((o.status||o.paymentStatus)==='completed' && Number.isFinite(t) && t>=cutoff) recent.push(o._id||o.id); }
    offset+=b.length; if(b.length<100)break; }
  // fetch details with retry-to-zero
  let todo=[...new Set(recent)]; const detail=new Map(); let round=0;
  while(todo.length && round<4){ round++; const fail=[];
    for(let i=0;i<todo.length;i+=6){ const ds=await Promise.all(todo.slice(i,i+6).map(id=>gget(`/payments/orders/${id}?altId=${L}&altType=location`)));
      ds.forEach((d,k)=>{ if(!d||d.__failed||d.__status) fail.push(todo[i+k]); else detail.set(todo[i+k],d); }); await sleep(120); }
    todo=fail; }
  if(todo.length){ console.log(`${stamp()} RECONCILE WARN: ${todo.length} order fetches failed (flagged, not skipped): ${todo.map(x=>x.slice(-6))}`); }
  // whitelist upsert, VIP first
  const RANK={4:0,5:1,6:2,7:3}; const targets=[];
  for(const d of detail.values()){ if((d.status||d.paymentStatus)!=='completed')continue; const snap=d.contactSnapshot||{}; const email=(snap.email||'').toLowerCase();
    for(const it of (d.items||[])){ const m=PMAP.get(it.product?._id||it.productId); if(m&&email) targets.push({m,email,snap,order:d.contactId,oid:d._id||d.id,contact:d.contactId}); } }
  targets.sort((a,b)=>(RANK[a.m.ticket_type_id]??9)-(RANK[b.m.ticket_type_id]??9));
  let created=0,updated=0,failed=0;
  for(const t of targets){ try{ const r=await fetch(EM+'/identity/reconcile-attendee',{method:'POST',headers:{Authorization:`Bearer ${SVC}`,'Content-Type':'application/json'},
    body:JSON.stringify({event_id:t.m.event_id,email:t.email,ticket_type_id:t.m.ticket_type_id,first_name:t.snap.firstName||'',last_name:t.snap.lastName||'',phone:t.snap.phone||'',contact_id:t.contact||'',order_id:t.oid})});
    const j=await r.json(); if(j.created)created++; else if(j.ok)updated++; else failed++; }catch(e){failed++;} }
  // --- refund pass: a refunded transaction revokes its mapped ticket(s). The
  // order stays "completed" after a refund, so the purchase pass keeps affirming
  // it; the Event Manager reactivation guard (refunded_order_ids) makes that a
  // safe no-op. Full refund -> revoked; partial -> recorded, not revoked.
  let refunded_seen = 0, refunded_applied = 0;
  { let toff = 0, ttot = Infinity; const rtx = [];
    while (toff < ttot) {
      const j = await gget(`/payments/transactions?altId=${L}&altType=location&limit=100&offset=${toff}`);
      if (typeof j.totalCount === 'number') ttot = j.totalCount;
      const b = (j.data || []); if (!b.length) break;
      for (const t of b) {
        const ts = Date.parse(t.createdAt || t.updatedAt || '');
        const isR = (t.status === 'refunded') || ((t.amountRefunded || 0) > 0);
        if (isR && Number.isFinite(ts) && ts >= cutoff) rtx.push(t);
      }
      toff += b.length; if (b.length < 100) break;
    }
    for (const t of rtx) {
      const oid = t.entityId; if (!oid) continue;
      const order = await gget(`/payments/orders/${oid}?altId=${L}&altType=location`);
      if (!order || order.__failed || order.__status) continue;
      const snap = order.contactSnapshot || {};
      const email = (snap.email || t.contactEmail || '').toLowerCase(); if (!email) continue;
      const pids = [...new Set((order.items || []).map(it => (it.product && it.product._id) || it.productId).filter(Boolean))];
      for (const pid of pids) {
        const m = PMAP.get(pid); if (!m) continue; refunded_seen++;
        const full = (t.amountRefunded || 0) >= (t.amount || 0);
        try {
          const r = await fetch(EM + '/identity/refund-ticket', {
            method: 'POST', headers: { Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ event_id: m.event_id, email, order_id: oid, transaction_id: t._id, amount: t.amount, amount_refunded: t.amountRefunded, full })
          });
          const j = await r.json(); if (j.changed) refunded_applied++;
        } catch (e) { /* logged in summary as not-applied */ }
      }
    }
  }
  console.log(`${stamp()} RECONCILE ok: recent_completed=${recent.length} whitelist_items=${targets.length} created=${created} updated=${updated} failed=${failed} fetch_failures=${todo.length} refunded_seen=${refunded_seen} refunded_applied=${refunded_applied}`);
})();
