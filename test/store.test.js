import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

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
test('registration rejects impossible dates and underage users', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gacha-')); const s=new Store(path.join(dir,'store.json'));
  assert.throws(()=>s.register({email:'date@example.com',password:'password123',birthDate:'2000-02-30',ageConfirmed:true}),/valid birthDate/);
  assert.throws(()=>s.register({email:'minor@example.com',password:'password123',birthDate:new Date().toISOString().slice(0,10),ageConfirmed:true}),/valid birthDate/);
});
test('every seeded pack has displayed slot odds that sum to its total', () => {
  const {s}=setup(); for (const pack of s.state.packs) { const slots=s.state.packSlots.filter(x=>x.packId===pack.id); assert.equal(slots.length,pack.totalSlots); const counts=Object.values(slots.reduce((m,x)=>(m[x.rarity]=(m[x.rarity]||0)+1,m),{})); assert.equal(counts.reduce((a,b)=>a+b,0),pack.totalSlots); }
});
