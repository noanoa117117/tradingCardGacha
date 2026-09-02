import http from 'node:http';
import fs from 'node:fs';
import { Store, publicCard, publicUser } from './store.js';

const store = new Store();
const port = Number(process.env.PORT || 3000);
const indexHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}); res.end(JSON.stringify(body)); };
const body = req => new Promise((resolve, reject) => { let data=''; req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('request too large')); }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } }); req.on('error', reject); });
const token = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function requireUser(req, res) { const user = store.userForToken(token(req)); if (!user) { json(res, 401, {error:'authentication required'}); return null; } return user; }
function requireAdmin(req, res) { const user = requireUser(req,res); if (!user) return null; if (user.role !== 'admin') { json(res,403,{error:'admin required'}); return null; } return user; }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const path = url.pathname;
    if (req.method === 'GET' && path === '/api/packs') return json(res,200,{packs:store.publicPacks()});
    if (req.method === 'GET' && path.startsWith('/api/packs/')) { const p=store.publicPacks().find(x=>x.id===path.split('/').pop()); return p ? json(res,200,{pack:p, odds:odds(store,p.id), lineup:lineup(store,p.id)}) : json(res,404,{error:'pack not found'}); }
    if (req.method === 'POST' && path === '/api/auth/register') { const u=store.register(await body(req)); return json(res,201,{user:publicUser(u)}); }
    if (req.method === 'POST' && path === '/api/auth/login') { const b=await body(req); return json(res,200,store.login(b.email,b.password)); }
    if (req.method === 'POST' && path === '/api/auth/logout') { if (token(req)) store.logout(token(req)); return json(res,204,{}); }
    if (req.method === 'GET' && path === '/api/me') { const u=requireUser(req,res); return u && json(res,200,{user:publicUser(u)}); }
    if (req.method === 'POST' && path === '/api/admin/points') { const u=requireAdmin(req,res); if(!u)return; const b=await body(req); const balance=await store.atomic(()=>store.addPoints(b.userId,Number(b.amount),'admin_grant',{adminId:u.id})); return json(res,200,{balance}); }
    if (req.method === 'POST' && path === '/api/draw') { const u=requireUser(req,res); if(!u)return; const b=await body(req); const quantity = b.quantity === 'all' ? store.publicPacks().find(p=>p.id===b.packId)?.remaining : Number(b.quantity || 1); return json(res,200,await store.draw(u.id,b.packId,quantity)); }
    if (req.method === 'GET' && path === '/api/cards') { const u=requireUser(req,res); return u && json(res,200,{cards:store.publicCards(u.id)}); }
    if (req.method === 'POST' && path === '/api/cards/redeem') { const u=requireUser(req,res); if(!u)return; const b=await body(req); return json(res,200,await store.redeemMany(u.id,b.userCardIds)); }
    if (req.method === 'POST' && path.startsWith('/api/cards/') && path.endsWith('/redeem')) { const u=requireUser(req,res); if(!u)return; const id=path.split('/')[3]; return json(res,200,await store.redeem(u.id,id)); }
    if (req.method === 'GET' && path === '/api/transactions') { const u=requireUser(req,res); return u && json(res,200,{transactions:store.state.pointTransactions.filter(x=>x.userId===u.id)}); }
    if (req.method === 'GET' && path === '/api/effects') return json(res,200,{effects:store.state.effectVideos});
    if (req.method === 'POST' && path === '/api/addresses') { const u=requireUser(req,res); if(!u)return; return json(res,201,{address:await store.addAddress(u.id,await body(req))}); }
    if (req.method === 'GET' && path === '/api/addresses') { const u=requireUser(req,res); return u && json(res,200,{addresses:store.state.addresses.filter(a=>a.userId===u.id)}); }
    if (req.method === 'POST' && path === '/api/shipments') { const u=requireUser(req,res); if(!u)return; const b=await body(req); return json(res,201,{shipment:await store.createShipment(u.id,b.userCardIds,b.addressId)}); }
    if (req.method === 'GET' && path === '/api/shipments') { const u=requireUser(req,res); return u && json(res,200,{shipments:store.state.shipments.filter(s=>s.userId===u.id)}); }
    if (req.method === 'GET' && path === '/api/admin/draws') { if(!requireAdmin(req,res))return; return json(res,200,{draws:store.state.draws}); }
    if (req.method === 'GET' && path === '/api/admin/draws/verify') { if(!requireAdmin(req,res))return; return json(res,200,{valid:store.verifyDrawLog(),count:store.state.draws.length}); }
    if (req.method === 'GET' && path === '/api/admin/users') { if(!requireAdmin(req,res))return; return json(res,200,{users:store.state.users.map(publicUser)}); }
    if (req.method === 'POST' && path === '/api/admin/cards') { if(!requireAdmin(req,res))return; return json(res,201,{card:await store.createCard(await body(req))}); }
    if (req.method === 'POST' && path === '/api/admin/packs') { if(!requireAdmin(req,res))return; return json(res,201,{pack:await store.createPack(await body(req))}); }
    if (req.method === 'POST' && path === '/api/admin/effects') { if(!requireAdmin(req,res))return; return json(res,200,{effect:await store.setEffect(await body(req))}); }
    if (req.method === 'GET' && path === '/api/admin/shipments') { if(!requireAdmin(req,res))return; return json(res,200,{shipments:store.state.shipments}); }
    if (req.method === 'GET' && path === '/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; img-src 'self' data:; media-src 'self' https:; script-src 'unsafe-inline'; style-src 'unsafe-inline'"}); return res.end(indexHtml); }
    json(res,404,{error:'not found'});
  } catch (e) { json(res, e.message === 'invalid credentials' ? 401 : 400, {error:e.message}); }
});
function odds(storeLike, packId) { const slots=storeLike.state.packSlots.filter(s=>s.packId===packId); const counts={}; for(const s of slots)counts[s.rarity]=(counts[s.rarity]||0)+1; return Object.fromEntries(Object.entries(counts).map(([rarity,count])=>[rarity,{count,total:slots.length,probability:`${count}/${slots.length}`}])) }
function lineup(storeLike, packId) { const slots=storeLike.state.packSlots.filter(s=>s.packId===packId); const counts=new Map(); for (const slot of slots) counts.set(slot.cardId,(counts.get(slot.cardId)||0)+1); return [...counts].map(([cardId,count])=>({card:publicCard(storeLike.state.cards.find(c=>c.id===cardId)),count})).sort((a,b)=>rarityRank(b.card.rarity)-rarityRank(a.card.rarity)); }
function rarityRank(rarity) { return ({N:0,R:1,SR:2,SSR:3})[rarity] ?? -1; }

if (process.env.NODE_ENV !== 'test') server.listen(port, () => console.log(`gacha server listening on http://localhost:${port}`));
export { server, store };
