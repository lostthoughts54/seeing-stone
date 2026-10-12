const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const build = resolve(process.env.IPTV_TEST_BUILD || 'dist');
const { IptvService } = require(join(build, 'main/services/iptvService.js'));
const { SqlitePersistenceService } = require(join(build, 'main/services/persistence.js'));
const { IptvProviderStore } = require(join(build, 'main/services/iptvProviderStore.js'));
const now = Math.floor(Date.now() / 3600000) * 3600000;
const stamp = time => new Date(time).toISOString().replace(/[-:]/g, '').replace('T', '').slice(0, 14) + ' +0000';
async function fixture(t) {
  const state = { bad: false, downloads: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/xmltv.php') {
      state.downloads++; res.setHeader('Content-Type','application/xml');
      if (state.bad) { res.end('<tv><programme>broken'); return; }
      const xml = `<?xml version="1.0"?><tv>
      <programme channel="sports" start="${stamp(now)}" stop="${stamp(now+3600000)}"><title>College Football &amp; Highlights</title><desc><![CDATA[ESPN game]]></desc></programme>
      <programme channel="sports" start="${stamp(now+3600000)}" stop="${stamp(now+7200000)}"><title>Café 日本語</title></programme>
      <programme channel="expired" start="${stamp(now-3600000)}" stop="${stamp(now)}"><title>College Football</title></programme>
      <programme channel="future" start="${stamp(now+10800000)}" stop="${stamp(now+14400000)}"><title>College Football</title></programme></tv>`;
      // Exercise chunk boundaries inside UTF-8, attributes and entity references.
      const bytes = Buffer.from(xml); for (let i=0;i<bytes.length;i+=7) res.write(bytes.subarray(i,i+7)); res.end(); return;
    }
    res.setHeader('Content-Type','application/json');
    const action=url.searchParams.get('action');
    const rows=Array.from({length:65},(_,i)=>({stream_id:i+1,name:i===0?'College channel':i===59?'ESPN':i===60?'ABC':`Station ${i+1}`,num:i+1,category_id:i===60?'2':'1',epg_channel_id:i===59||i===60?'sports':i===61?'expired':i===62?'future':`station${i}`}));
    res.end(JSON.stringify(!action?{user_info:{auth:1,status:'Active'}}:action==='get_live_streams'?rows:action==='get_live_categories'?[{category_id:'1',category_name:'Sports'},{category_id:'2',category_name:'Network'}]:[]));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const db=new SqlitePersistenceService(await mkdtemp(join(tmpdir(),'iptv-guide-test-')));
  const store=new IptvProviderStore(db,{isAvailable:async()=>true,encrypt:async v=>Buffer.from(v),decrypt:async v=>({result:Buffer.from(v).toString(),shouldReEncrypt:false})});
  const service=new IptvService(store,db);
  t.after(async()=>{await service.shutdown();await db.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const {providerId}=await service.setup({kind:'xtream',name:'Test',address:`http://127.0.0.1:${server.address().port}`,username:'viewer',password:'fixture-password'});
  for(let i=0;i<200;i++){if((await service.list())[0].phase==='ready')break;await new Promise(r=>setTimeout(r,10));}
  return {service,state,providerId,input:{providerId,contentType:'live',query:'college',programmeWindow:{startUtc:new Date(now).toISOString(),endUtc:new Date(now+10800000).toISOString()}}};
}
test('full guide searches programmes beyond the first page, preserves favourites, category and pagination',async t=>{
  const {service,state,providerId,input}=await fixture(t);
  await service.favourite({providerId,channelId:'60',favourite:true});
  const page=await service.catalogue({...input,limit:1});
  assert.equal(page.items[0].name,'ESPN'); assert.ok(page.nextCursor);
  const second=await service.catalogue({...input,limit:1,cursor:page.nextCursor}); assert.equal(second.items[0].name,'ABC');
  const third=await service.catalogue({...input,limit:1,cursor:second.nextCursor}); assert.equal(third.items[0].name,'College channel'); assert.equal(third.nextCursor,null);
  assert.deepEqual((await service.catalogue({...input,groupId:'2'})).items.map(x=>x.name),['ABC']);
  assert.deepEqual((await service.catalogue({...input,favouritesOnly:true})).items.map(x=>x.name),['ESPN']);
  assert.equal((await service.catalogue({...input,query:'cafe'})).items.length,2);
  assert.equal((await service.catalogue({...input,query:'日本語'})).items.length,2);
  assert.equal((await service.catalogue({...input,query:'absent'})).items.length,0);
  assert.equal((await service.catalogue({...input,query:'" OR *'})).items.length,0);
  assert.equal((await service.catalogue({...input,programmeWindow:undefined})).items.length,1);
  assert.equal((await service.schedule(providerId,'60')).programmes[0].title,'College Football & Highlights');
  assert.equal(state.downloads,1);
  await assert.rejects(service.catalogue({...input,cursor:page.nextCursor,programmeWindow:{startUtc:new Date(now+3600000).toISOString(),endUtc:new Date(now+14400000).toISOString()}}),{code:'IPTV_SNAPSHOT_STALE'});
});
test('malformed full guides fail explicitly, never publish partial results, and can retry',async t=>{
  const {service,state,input}=await fixture(t); state.bad=true;
  await assert.rejects(service.catalogue(input),{code:'IPTV_PROGRAMME_SEARCH_UNAVAILABLE'});
  state.bad=false; assert.equal((await service.catalogue(input)).items.length,3);
});
