import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, POINT_PLANS, drawLogCsv, cardCsv, shipmentLabelCsv, generateTotp, ageAtLeast18 } from '../src/store.js';

test('guest storefront exposes packs and routes draw attempts to registration', () => {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /else if\(surface==='user'\)enterGuest/);
  assert.match(html, /async function enterGuest\(\).*await loadPacks\(\)/);
  assert.match(html, /if\(!currentUser\)\{ selectAuth\('register'\)/);
  assert.match(html, /class="tab user-only member-only" data-view="cards-view"/);
  assert.match(html, /id="show-login"/);
  assert.match(html, /id="show-register"/);
});

test('admin UI separates feature tabs and gates them by role attributes', () => {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  for (const view of ['overview', 'users', 'cards', 'packs', 'effects', 'shipping']) {
    assert.match(html, new RegExp(`id="admin-${view}-view"`));
  }
  assert.match(html, /data-view="admin-users-view" data-admin-roles="owner"/);
  assert.match(html, /data-view="admin-cards-view" data-admin-roles="owner operator"/);
  assert.match(html, /data-view="admin-shipping-view" data-admin-roles="owner operator viewer"/);
  assert.match(html, /function applyAdminRole\(role\)/);
  assert.match(html, /const editable=\['owner','operator'\]\.includes\(currentUser\?\.role\)/);
  assert.match(html, /id="admin-inventory"/);
  assert.match(html, /id="admin-pack-detail-view"/);
  assert.match(html, /data-pack-status="selling"/);
  assert.match(html, /async function showAdminPackDetail\(packId\)/);
  assert.match(html, /data-admin-pack-detail/);
  assert.match(html, /詳細・編集/);
});

function setup() { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gacha-')); const s=new Store(path.join(dir,'store.json')); const u=s.register({email:'user@example.com',password:'password123',birthDate:'1990-01-01',ageConfirmed:true}); s.addPoints(u.id,100000); return {s,u}; }
test('draw is non-replacement and keeps point/card/log consistency', async () => {
  const {s,u}=setup(); const pack=s.state.packs[0]; const before=s.state.packSlots.filter(x=>x.packId===pack.id&&!x.drawnAt).length;
  const result=await s.draw(u.id,pack.id,10); assert.equal(result.results.length,10);
  const after=s.state.packSlots.filter(x=>x.packId===pack.id&&!x.drawnAt).length; assert.equal(before-after,10);
  assert.equal(s.state.draws.length,10); assert.equal(s.state.userCards.length,10); assert.equal(s.state.users.find(x=>x.id===u.id).points,100000-pack.pricePoints*10);
  assert.equal(new Set(s.state.draws.map(x=>x.slotId)).size,10); assert.ok(s.state.draws.every(x=>x.remainingBefore-x.remainingAfter===1));
  assert.equal(s.verifyDrawLog(),true); s.state.draws[3].remainingAfter += 1; assert.equal(s.verifyDrawLog(),false);
});
test('draw is atomic on insufficient points', async () => { const {s,u}=setup(); const pack=s.state.packs[0]; s.state.users.find(x=>x.id===u.id).points=0; const snapshot=JSON.stringify(s.state); await assert.rejects(s.draw(u.id,pack.id,1),/insufficient points/); assert.equal(JSON.stringify(s.state),snapshot); });
test('redemption credits once and rejects repeat', async () => { const {s,u}=setup(); const r=await s.draw(u.id,s.state.packs[0].id,1); const uc=r.results[0].userCard; const points=s.state.users.find(x=>x.id===u.id).points; const out=await s.redeem(u.id,uc.id); assert.equal(out.balance,points+r.results[0].card.redeemPoints); await assert.rejects(s.redeem(u.id,uc.id),/not redeemable/); });
test('concurrent draws serialize without double spending slots', async () => {
  const {s,u}=setup(); const pack=s.state.packs[0];
  const results = await Promise.all(Array.from({length: 35}, () => s.draw(u.id, pack.id, 1).catch(error => error.message)));
  const successful = results.filter(x => typeof x !== 'string');
  assert.equal(successful.length, 30);
  assert.equal(new Set(s.state.draws.map(x => x.slotId)).size, 30);
  assert.equal(s.state.users.find(x => x.id === u.id).points, 100000 - 30 * pack.pricePoints);
});
test('bulk redemption and shipment enforce ownership and state transitions', async () => {
  const {s,u}=setup(); const r=await s.draw(u.id,s.state.packs[0].id,2); const ids=r.results.map(x=>x.userCard.id);
  await assert.rejects(s.redeemMany(u.id,[ids[0],ids[0]]),/duplicate card ids/);
  const address=await s.addAddress(u.id,{name:'Test User',postalCode:'100-0001',prefecture:'Tokyo',city:'Chiyoda',line1:'1-1',id:'attacker',userId:'other'});
  assert.equal(s.state.addresses[0].userId,u.id); assert.notEqual(s.state.addresses[0].id,'attacker');
  await assert.rejects(s.createShipment(u.id,[ids[0],ids[0]],address.id),/duplicate/);
  const shipment=await s.createShipment(u.id,ids,address.id); assert.equal(shipment.status,'requested'); assert.deepEqual(s.publicCards(u.id).map(x=>x.status),['shipping_requested','shipping_requested']);
  await assert.rejects(s.redeemMany(u.id,ids),/not redeemable/);
  const r2=await s.draw(u.id,s.state.packs[0].id,2); const before=s.state.users.find(x=>x.id===u.id).points; const redeemed=await s.redeemMany(u.id,r2.results.map(x=>x.userCard.id)); assert.equal(redeemed.userCards.length,2); assert.ok(redeemed.balance>before);
});
test('admin shipment updates transition cards and preserve tracking data', async () => {
  const {s,u}=setup(); const r=await s.draw(u.id,s.state.packs[0].id,1); const cardId=r.results[0].userCard.id;
  const address=await s.addAddress(u.id,{name:'Test User',postalCode:'100-0001',prefecture:'Tokyo',city:'Chiyoda',line1:'1-1'});
  const shipment=await s.createShipment(u.id,[cardId],address.id);
  await assert.rejects(s.updateShipment(shipment.id,{status:'invalid'}),/invalid shipment status/);
  const processing=await s.updateShipment(shipment.id,{status:'processing'}); assert.equal(processing.status,'processing');
  const shipped=await s.updateShipment(shipment.id,{status:'shipped',trackingNumber:'JP-123,456'}); assert.equal(shipped.trackingNumber,'JP-123,456');
  assert.equal(s.state.userCards.find(card=>card.id===cardId).status,'shipped');
  await assert.rejects(s.updateShipment(shipment.id,{status:'processing'}),/cannot change status/);
});
test('draw log CSV has stable columns, escaping, and formula-injection protection', () => {
  const csv=drawLogCsv([{id:'=bad',userId:'u,1',packId:'p',slotId:'s',cardId:'c',rarity:'N',remainingBefore:2,remainingAfter:1,createdAt:'2026-01-01T00:00:00Z',previousHash:null,hash:'h'}]);
  assert.match(csv,/^id,userId,packId,slotId,cardId,rarity,remainingBefore,remainingAfter,createdAt,previousHash,hash\r\n/);
  assert.match(csv,/\'=bad,"u,1",p,s,c,N,2,1,/);
});
test('registration rejects impossible dates and underage users', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gacha-')); const s=new Store(path.join(dir,'store.json'));
  assert.throws(()=>s.register({email:'date@example.com',password:'password123',birthDate:'2000-02-30',ageConfirmed:true}),/valid birthDate/);
  assert.throws(()=>s.register({email:'minor@example.com',password:'password123',birthDate:new Date().toISOString().slice(0,10),ageConfirmed:true}),/valid birthDate/);
});
test('birthdate age checks use Asia/Tokyo calendar boundaries', () => {
  // 2026-09-05 00:00 JST is the exact eighteenth birthday boundary.
  assert.equal(ageAtLeast18('2008-09-05', Date.UTC(2026, 8, 4, 14, 59, 59)), false);
  assert.equal(ageAtLeast18('2008-09-05', Date.UTC(2026, 8, 4, 15, 0, 0)), true);
  assert.equal(ageAtLeast18('2008-02-29', Date.UTC(2026, 1, 28, 14, 59, 59)), false);
  assert.equal(ageAtLeast18('2008-02-29', Date.UTC(2026, 2, 1, 0, 0, 0)), true);
  assert.equal(ageAtLeast18('2000-02-30', Date.UTC(2026, 8, 5)), false);
  assert.equal(ageAtLeast18('2027-01-01', Date.UTC(2026, 8, 5)), false);
});
test('every seeded pack has displayed slot odds that sum to its total', () => {
  const {s}=setup(); for (const pack of s.state.packs) { const slots=s.state.packSlots.filter(x=>x.packId===pack.id); assert.equal(slots.length,pack.totalSlots); const counts=Object.values(slots.reduce((m,x)=>(m[x.rarity]=(m[x.rarity]||0)+1,m),{})); assert.equal(counts.reduce((a,b)=>a+b,0),pack.totalSlots); }
});
test('admin authentication requires encrypted TOTP and uses an isolated 8h session', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gacha-admin-')); const oldSecret=process.env.ADMIN_2FA_SECRET; process.env.ADMIN_2FA_SECRET='JBSWY3DPEHPK3PXP';
  try {
    const s=new Store(path.join(dir,'store.json')); const admin=s.state.adminUsers[0]; const raw=fs.readFileSync(path.join(dir,'store.json'),'utf8'); assert.ok(admin.twoFactorSecretEnc); assert.doesNotMatch(raw,/JBSWY3DPEHPK3PXP/);
    assert.throws(()=>s.login('admin@example.com','admin-dev-password'),/must use \/admin/);
    const login=s.adminLogin('admin@example.com','admin-dev-password',generateTotp('JBSWY3DPEHPK3PXP'),{ip:'127.0.0.1',environment:'development'}); assert.equal(login.user.role,'owner'); assert.ok(Date.parse(login.expiresAt)-Date.now() <= 8*60*60*1000);
    assert.ok(s.adminForToken(login.token,{ip:'127.0.0.1',environment:'development'})); assert.equal(s.adminForToken(login.token,{ip:'10.0.0.1',environment:'development'}),null); assert.equal(s.userForToken(login.token),null);
  } finally { if(oldSecret===undefined) delete process.env.ADMIN_2FA_SECRET; else process.env.ADMIN_2FA_SECRET=oldSecret; }
});
test('admin role checks, IP allowlist and append-only audit records', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gacha-admin-')); const s=new Store(path.join(dir,'store.json')); const owner=s.state.adminUsers[0]; const created=s.createAdminUser({email:'viewer@example.com',password:'viewerpass123',role:'viewer'}); const viewer=s.state.adminUsers.find(a=>a.id===created.id); s.setAdminIpAllowlist(viewer.id,['192.0.2.1']); assert.throws(()=>s.adminLogin(viewer.email,'viewerpass123',generateTotp(created.twoFactorSecret),{ip:'127.0.0.1',environment:'development'}),/IP not allowed/); const log=s.appendAudit({actor:owner.id,action:'test',target:'x',before:{a:1},after:{a:2},ip:'127.0.0.1',reason:'test'}); assert.equal(s.state.adminAuditLogs.at(-1).id,log.id); assert.equal(s.state.adminAuditLogs.length,1); assert.deepEqual(s.state.adminAuditLogs[0].after,{a:2});
});
test('card CRUD and CSV import/export preserve required metadata', async () => {
  const {s}=setup(); const card=await s.createCard({name:'Pikachu',modelNumber:'PK-01',rarity:'SR',redeemPoints:123,marketPriceMemo:'=safe',conditionRank:'美品',imageUrl:'https://cdn.example.test/p.png'});
  assert.equal(card.modelNumber,'PK-01'); assert.match(cardCsv([card]),/modelNumber/); const imported=await s.importCardsCsv('name,modelNumber,rarity,imageUrl,redeemPoints,marketPriceMemo,conditionRank\n"CSV Card",CSV-1,R,https://cdn.example.test/c.png,10,"memo,ok",傷あり'); assert.equal(imported[0].name,'CSV Card'); assert.equal(imported[0].marketPriceMemo,'memo,ok');
  const updated=await s.updateCard(card.id,{name:'Pikachu EX'}); assert.equal(updated.name,'Pikachu EX'); const removed=await s.deleteCard(card.id); assert.equal(removed.id,card.id);
});
test('card registration merges stable identities and pack reservations move between pool and gacha inventory', async () => {
  const {s,u}=setup();
  const card=await s.createCard({name:'Inventory Card',modelNumber:'INV-001',rarity:'SR',redeemPoints:100,inventoryQuantity:5});
  const merged=await s.createCard({name:'Different label',modelNumber:'inv-001',rarity:'SR',redeemPoints:100,inventoryQuantity:2});
  assert.equal(merged.id,card.id); assert.equal(merged.merged,true); assert.equal(s.state.cards.filter(x=>x.id===card.id).length,1);
  const before=s.adminCards().find(x=>x.id===card.id); assert.equal(before.poolQuantity,7); assert.equal(before.gachaAssignedQuantity,0);
  const pack=await s.createPack({slug:'inventory-pack',name:'Inventory Pack',pricePoints:1,totalSlots:3,slots:[{cardId:card.id,count:3}]});
  const reserved=s.adminCards().find(x=>x.id===card.id); assert.equal(reserved.poolQuantity,4); assert.equal(reserved.gachaAssignedQuantity,3);
  await assert.rejects(s.createPack({slug:'too-many',name:'Too Many',pricePoints:1,totalSlots:5,slots:[{cardId:card.id,count:5}]}),/insufficient pool/);
  await s.updatePackStatus(pack.id,'selling'); await s.addPoints(u.id,100); await s.draw(u.id,pack.id,1);
  const drawn=s.adminCards().find(x=>x.id===card.id); assert.equal(drawn.inventoryQuantity,6); assert.equal(drawn.gachaAssignedQuantity,2); assert.equal(drawn.issuedQuantity,1);
  await s.updatePackStatus(pack.id,'deleted'); const released=s.adminCards().find(x=>x.id===card.id); assert.equal(released.poolQuantity,6); assert.equal(released.gachaAssignedQuantity,0); assert.equal(s.state.packSlots.filter(x=>x.packId===pack.id&&!x.drawnAt).length,0); assert.equal(s.state.userCards.length,1);
});
test('pack aggregate rows calculate odds, reject incomplete publication, and duplicate safely', async () => {
  const {s}=setup(); const a=s.state.cards.find(card=>card.rarity==='N'); const b=s.state.cards.find(card=>card.rarity==='SSR'); const pack=await s.createPack({slug:'aggregate',name:'Aggregate',pricePoints:10,totalSlots:100000,slots:[{cardId:a.id,count:99999,effectRank:'N'},{cardId:b.id,count:1,effectRank:'SSR'}]});
  assert.equal(pack.configuredSlots,100000); assert.equal(s.packOdds(pack.id).N.count,99999); assert.equal(s.packLineup(pack.id).length,2); const incomplete=await s.createPack({slug:'incomplete',name:'Incomplete',pricePoints:10,totalSlots:2,slots:[{cardId:a.id,count:1}]}); await assert.rejects(s.updatePackStatus(incomplete.id,'selling'),/incomplete/);
  const copy=await s.duplicatePack(pack.id); assert.equal(copy.status,'draft'); assert.notEqual(copy.id,pack.id); await s.updatePackStatus(pack.id,'selling'); await assert.rejects(s.updatePack(pack.id,{slots:[{cardId:a.id,count:1}]}),/immutable/);
  await s.updatePackStatus(pack.id,'stopped'); await assert.rejects(s.updatePack(pack.id,{slots:[{cardId:a.id,count:1}]}),/immutable/); await assert.rejects(s.updatePackStatus(pack.id,'selling'),/cannot be reopened/);
  const scheduled=await s.createPack({slug:'scheduled',name:'Scheduled',pricePoints:10,totalSlots:1,slots:[{cardId:a.id,count:1}],status:'scheduled',startsAt:new Date(Date.now()-1000).toISOString()}); assert.equal(s.publicPacks().find(p=>p.id===scheduled.id).status,'selling');
});
test('effect rank/video validation uses fallback without leaking private inventory', async () => {
  const {s}=setup(); const rank=await s.setEffectRank({name:'ULTRA',label:'Ultra'}); assert.equal(rank.name,'ULTRA'); await assert.rejects(s.setEffect({rarity:'ULTRA',url:'javascript:alert(1)'}),/URL/); await s.setEffect({rarity:'ULTRA',url:'https://cdn.example.test/e.webm',mimeType:'video/webm',sizeBytes:1024}); const p=s.publicPacks()[0]; assert.equal('rareRemaining' in p,false);
});
test('admin P2 user search, status controls, atomic points, inventory and anomaly monitor', async () => {
  const {s,u}=setup(); s.state.users.find(x=>x.id===u.id).phone='090-1234-5678';
  assert.equal(s.searchUsers({phone:'1234'})[0].id,u.id); const detail=s.userDetails(u.id); assert.equal(detail.user.phone,'090-1234-5678');
  const admin=s.state.adminUsers[0]; const pointsBefore=s.state.users.find(x=>x.id===u.id).points;
  const adjusted=await s.adjustPointsByAdmin({userId:u.id,amount:123,reason:'テスト補填',adminId:admin.id,ip:'127.0.0.1'}); assert.equal(adjusted.balance,pointsBefore+123); assert.equal(s.state.pointTransactions.at(-1).type,'admin_operation'); assert.equal(s.state.adminAuditLogs.at(-1).action,'points.adjust');
  await assert.rejects(s.adjustPointsByAdmin({userId:u.id,amount:-999999999,reason:'bad',adminId:admin.id}),/insufficient/);
  await s.setUserStatus(u.id,'frozen',{adminId:admin.id,reason:'安全確認'}); assert.equal(s.state.users.find(x=>x.id===u.id).status,'frozen'); assert.equal(s.userForToken('missing'),null); await s.setUserStatus(u.id,'active',{adminId:admin.id,reason:'復旧'}); assert.equal(s.state.users.find(x=>x.id===u.id).status,'active');
  await assert.rejects(s.setUserStatus(admin.userId,'frozen',{adminId:admin.id,reason:'invalid target'}),/user not found/); await assert.rejects(s.adjustPointsByAdmin({userId:admin.userId,amount:1,reason:'invalid target',adminId:admin.id}),/user not found/);
  const inventory=s.adminInventory(); assert.equal(inventory[0].remaining,s.state.packSlots.filter(x=>x.packId===inventory[0].id&&!x.drawnAt).length); assert.ok(!('rareRemaining' in s.publicPacks()[0]));
  assert.deepEqual(s.detectDrawAnomalies(),[]);
});
test('P3 payments keep provider pending boundary and refund is retryable/idempotent', async () => {
  const {s,u}=setup(); const pending=await s.createPayment({userId:u.id,points:500,amount:500}); assert.equal(pending.status,'pending'); assert.equal(s.state.users.find(x=>x.id===u.id).points,100000);
  let fail=true; s.setPaymentProvider({createPayment:async()=>({id:'pi_test',status:'succeeded'}),refund:async()=>{if(fail){fail=false;throw new Error('temporary provider failure');}return {id:'re_test'};}});
  const payment=await s.createPayment({userId:u.id,points:500,amount:500}); assert.equal(payment.status,'paid'); assert.equal(payment.stripePaymentId,'pi_test'); const balance=s.state.users.find(x=>x.id===u.id).points;
  await assert.rejects(s.refundPayment(payment.id,{adminId:s.state.adminUsers[0].id,reason:'customer request'}),/temporary/); assert.equal(s.state.payments.find(x=>x.id===payment.id).status,'refund_failed'); assert.equal(s.state.users.find(x=>x.id===u.id).points,balance);
  const refunded=await s.refundPayment(payment.id,{adminId:s.state.adminUsers[0].id,reason:'retry'}); assert.equal(refunded.status,'refunded'); assert.equal(s.state.users.find(x=>x.id===u.id).points,balance-500); await assert.rejects(s.refundPayment(payment.id,{adminId:s.state.adminUsers[0].id,reason:'duplicate'}),/already refunded/);
});
test('point purchase boundary rejects frozen or underage users before any provider call', async () => {
  const {s,u}=setup();
  assert.equal(POINT_PLANS.find(plan=>plan.id==='points_1000').currency,'JPY');
  s.state.users.find(user=>user.id===u.id).status='frozen';
  await assert.rejects(s.createPayment({userId:u.id,points:1000,amount:1000}),/frozen/);
  s.state.users.find(user=>user.id===u.id).status='active';
  s.state.users.find(user=>user.id===u.id).birthDate='2015-01-01';
  await assert.rejects(s.createPayment({userId:u.id,points:1000,amount:1000}),/at least 18/);
});
test('P3 bank reconciliation, settings, dashboard and shipment label CSV', async () => {
  const {s,u}=setup(); const transfer=await s.createBankTransfer({userId:null,points:200,amount:200,reference:'BANK-1'}); const reconciled=await s.reconcileBankTransfer(transfer.id,{userId:u.id,adminId:s.state.adminUsers[0].id,reason:'入金確認'}); assert.equal(reconciled.status,'reconciled'); assert.equal(s.state.users.find(x=>x.id===u.id).points,100200); await assert.rejects(s.reconcileBankTransfer(transfer.id,{userId:u.id,adminId:s.state.adminUsers[0].id,reason:'二重'}),/already reconciled/);
  const settings=await s.updateSiteSettings({announcement:'お知らせ',banner:'top',presets:[{points:100}],bonusRate:10,maintenance:false,termsMarkdown:'# terms',legalMarkdown:'# legal'},{adminId:s.state.adminUsers[0].id,reason:'運用更新'}); assert.equal(settings.banner,'top'); assert.equal(settings.termsMarkdown,'# terms');
  const pending=await s.createPayment({userId:u.id,points:100,amount:100,stripePaymentId:'pi_dash'}); const paid=await s.markPaymentPaid(pending.id,{stripePaymentId:'pi_dash'}); assert.equal(paid.status,'paid'); const dash=s.dashboard(); assert.equal(dash.drawCount,0); assert.equal(dash.sales.total,100);
  const draw=await s.draw(u.id,s.state.packs[0].id,1); const address=await s.addAddress(u.id,{name:'=Name',postalCode:'100-0001',prefecture:'Tokyo',city:'Chiyoda',line1:'1-1'}); const shipment=await s.createShipment(u.id,[draw.results[0].userCard.id],address.id); const csv=shipmentLabelCsv(s.listShipments(),s.state); assert.match(csv,/shipmentId,status/); assert.match(csv,/'=Name/);
});
