import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_FILE = process.env.GACHA_DATA_FILE || path.join(process.cwd(), 'data', 'store.json');
const clone = value => JSON.parse(JSON.stringify(value));
const id = prefix => `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
const DEFAULT_DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
// Fixed, server-owned point plans.  The client may select a plan ID but never
// controls the points, amount, or currency attached to it.
export const POINT_PLANS = Object.freeze([
  Object.freeze({ id: 'points_1000', points: 1000, amount: 1000, currency: 'JPY', label: '1,000ポイント' }),
  Object.freeze({ id: 'points_3000', points: 3000, amount: 3000, currency: 'JPY', label: '3,000ポイント' }),
  Object.freeze({ id: 'points_5000', points: 5000, amount: 5000, currency: 'JPY', label: '5,000ポイント' }),
  Object.freeze({ id: 'points_10000', points: 10000, amount: 10000, currency: 'JPY', label: '10,000ポイント' })
]);
export function pointPlanById(planId) { return POINT_PLANS.find(plan => plan.id === String(planId || '')) || null; }
export function drawLogCsv(draws) {
  const headers = ['id','userId','packId','slotId','cardId','rarity','remainingBefore','remainingAfter','createdAt','previousHash','hash'];
  const csvValue = value => { const text = String(value ?? ''); const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"','""')}"` : safe; };
  return [headers, ...draws.map(draw => headers.map(key => csvValue(draw[key])))].map(row => row.join(',')).join('\r\n') + '\r\n';
}
const PACK_STATUSES = new Set(['draft', 'scheduled', 'selling', 'sold_out', 'stopped', 'deleted']);
const CARD_HEADERS = ['id','name','modelNumber','rarity','imageUrl','thumbnailUrl','redeemPoints','marketPriceMemo','conditionRank','inventoryQuantity'];
export function cardCsv(cards) {
  const csvValue = value => { const text=String(value ?? ''); const safe=/^[=+\-@]/.test(text) ? `'${text}` : text; return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"','""')}"` : safe; };
  return [CARD_HEADERS, ...cards.map(card=>CARD_HEADERS.map(key=>csvValue(card[key])))].map(row=>row.join(',')).join('\r\n')+'\r\n';
}
export function shipmentLabelCsv(shipments, state = null) {
  const csvValue = value => { const text=String(value ?? ''); const safe=/^[=+\-@]/.test(text) ? `'${text}` : text; return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"','""')}"` : safe; };
  const headers=['shipmentId','status','trackingNumber','createdAt','recipient','postalCode','prefecture','city','line1','line2','phone','cards'];
  const rows = shipments.map(shipment => {
    const address = state?.addresses?.find(a=>a.id===shipment.addressId) || shipment.address || {};
    const ids = state ? state.shipmentItems.filter(i=>i.shipmentId===shipment.id).map(i=>i.userCardId) : (shipment.userCardIds || []);
    const cards = state ? ids.map(uid=>{ const uc=state.userCards.find(c=>c.id===uid); const card=uc&&state.cards.find(c=>c.id===uc.cardId); return card ? `${card.name} (${card.rarity})` : uid; }).join(' | ') : ids.join(' | ');
    return [shipment.id,shipment.status,shipment.trackingNumber,shipment.createdAt,address.name,address.postalCode,address.prefecture,address.city,address.line1,address.line2,address.phone,cards].map(csvValue);
  });
  return [headers,...rows].map(row=>row.join(',')).join('\r\n')+'\r\n';
}
export function paymentCsv(payments = []) {
  const headers = ['id', 'userId', 'email', 'status', 'amount', 'currency', 'points', 'paymentMethod', 'provider', 'providerPaymentId', 'createdAt', 'paidAt', 'paidAtEstimated', 'refundedAt', 'refundAmount'];
  const csvValue = value => {
    const text = String(value ?? '');
    const safe = /^[\s\t\r\n]*[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return `\ufeff${[headers, ...payments.map(payment => headers.map(key => csvValue(payment[key])))].map(row => row.join(',')).join('\r\n')}\r\n`;
}
function parseCsv(text) {
  const rows=[]; let row=[], field='', quoted=false;
  for(let i=0;i<text.length;i++){ const ch=text[i]; if(quoted){ if(ch==='"'&&text[i+1]==='"'){field+='"';i++;} else if(ch==='"')quoted=false; else field+=ch; } else if(ch==='"'&&field===''){quoted=true;} else if(ch===','){row.push(field);field='';} else if(ch==='\n'){row.push(field.replace(/\r$/,''));field='';if(row.some(x=>x!==''))rows.push(row);row=[];} else field+=ch; }
  if(field||row.length){row.push(field.replace(/\r$/,''));if(row.some(x=>x!==''))rows.push(row);}
  if(!rows.length)return []; const header=rows.shift().map((x,index)=>index===0?x.replace(/^\uFEFF/,'').trim():x.trim()); return rows.map(values=>Object.fromEntries(header.map((key,index)=>[key,values[index]??''])));
}
function validRank(value) { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(String(value)); }
function isSafeMediaUrl(value) { return /^https:\/\//i.test(String(value)) || /^data:(?:image|video)\/(?:png|jpeg|jpg|webp|svg\+xml|mp4|webm);base64,[A-Za-z0-9+/=_-]+$/i.test(String(value)); }
function normalizeCard(card = {}, { partial = false } = {}) {
  if (partial && card.name === undefined && card.rarity === undefined && card.redeemPoints === undefined && card.modelNumber === undefined && card.inventoryQuantity === undefined && card.quantity === undefined && card.stock === undefined && card.stockQuantity === undefined && card.poolQuantity === undefined && card.count === undefined) return {};
  const name=card.name === undefined && partial ? undefined : String(card.name||'').trim(); const rarity=card.rarity === undefined && partial ? undefined : String(card.rarity||'').trim();
  const redeemPoints=card.redeemPoints === undefined && partial ? undefined : Number(card.redeemPoints);
  if ((!partial && (!name || !validRank(rarity) || !Number.isInteger(redeemPoints)||redeemPoints<0)) || (partial && ((name!==undefined&&!name)||(rarity!==undefined&&!validRank(rarity))||(redeemPoints!==undefined&&(!Number.isInteger(redeemPoints)||redeemPoints<0))))) return null;
  const item={}; if(name!==undefined)item.name=name; if(rarity!==undefined)item.rarity=rarity; if(redeemPoints!==undefined)item.redeemPoints=redeemPoints;
  const rawInventory = card.inventoryQuantity ?? card.quantity ?? card.stockQuantity ?? card.stock ?? card.poolQuantity ?? card.count;
  if (rawInventory !== undefined && rawInventory !== null && rawInventory !== '') { const inventoryQuantity=Number(rawInventory); if(!Number.isSafeInteger(inventoryQuantity)||inventoryQuantity<0) return null; item.inventoryQuantity=inventoryQuantity; }
  for(const key of ['modelNumber','imageUrl','thumbnailUrl','marketPriceMemo','conditionRank']) if(card[key]!==undefined) { if(card[key]!==null && String(card[key]).length>10000) return null; item[key]=card[key]===null?null:String(card[key]); }
  if(item.imageUrl && !isSafeMediaUrl(item.imageUrl)) return null; if(item.thumbnailUrl && !isSafeMediaUrl(item.thumbnailUrl)) return null;
  if(item.imageUrl && !item.thumbnailUrl) item.thumbnailUrl=item.imageUrl;
  return item;
}
function normalizeSlotRows(slots) {
  if(!Array.isArray(slots)) return [];
  const rows=[]; for(const slot of slots){ if(typeof slot==='string') rows.push({cardId:slot,count:1,effectRank:null}); else if(slot && typeof slot==='object') rows.push({cardId:String(slot.cardId||''),count:Number(slot.count ?? slot.quantity ?? 0),effectRank:slot.effectRank ? String(slot.effectRank) : null}); }
  const merged=new Map(); for(const row of rows){ if(!row.cardId) continue; const key=`${row.cardId}\u0000${row.effectRank||''}`; const prior=merged.get(key); if(prior)prior.count+=row.count; else merged.set(key,row); } return [...merged.values()];
}
function materializePackSlots(state, pack) {
  let index=0; for(const row of pack.slotRows || []) { const card=state.cards.find(c=>c.id===row.cardId); for(let n=0;n<row.count;n++) state.packSlots.push({id:`${pack.id}_slot_${++index}`,packId:pack.id,cardId:row.cardId,rarity:card.rarity,effectRank:row.effectRank||null,drawnAt:null}); }
}
function reservedCardCount(state, cardId, exceptPackId = null) { return state.packSlots.filter(slot=>slot.cardId===cardId&&!slot.drawnAt&&slot.packId!==exceptPackId&&state.packs.some(pack=>pack.id===slot.packId&&pack.status!=='deleted')).length; }
function cardIdentity(card) { const model=String(card.modelNumber||'').trim().toLowerCase(); return model ? `model:${model}` : `name:${String(card.name||'').trim().toLowerCase()}\u0000${String(card.conditionRank||'').trim().toLowerCase()}\u0000${String(card.rarity||'').trim().toLowerCase()}`; }
function cardInventoryQuantity(card) { return Number.isSafeInteger(card?.inventoryQuantity) && card.inventoryQuantity >= 0 ? card.inventoryQuantity : 0; }

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function passwordMatches(password, user) {
  const actual = passwordHash(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function emptyState() {
  return { users: [], sessions: [], adminUsers: [], adminSessions: [], adminAuditLogs: [], cards: [], packs: [], packSlots: [], draws: [], userCards: [], pointTransactions: [], effectRanks: [], effectVideos: [], addresses: [], shipments: [], shipmentItems: [], payments: [], bankTransfers: [], siteSettings: {}, announcements: [] };
}

const adminKey = () => { if (process.env.ADMIN_ENV === 'production' && !process.env.ADMIN_2FA_KEY) throw new Error('ADMIN_2FA_KEY is required in production'); return crypto.createHash('sha256').update(String(process.env.ADMIN_2FA_KEY || 'local-dev-admin-key-change-me')).digest(); };
function encryptSecret(secret) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', adminKey(), iv);
  const data = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
function decryptSecret(value) {
  try { const [, iv, tag, data] = String(value).split('.'); const decipher = crypto.createDecipheriv('aes-256-gcm', adminKey(), Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'); } catch { return null; }
}
function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of String(value).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) { const n = alphabet.indexOf(c); if (n < 0) return null; bits += n.toString(2).padStart(5, '0'); }
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out);
}
function randomBase32(bytes = 20) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const raw = crypto.randomBytes(bytes); let bits = ''; for (const value of raw) bits += value.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function totp(secret, timestamp = Date.now()) {
  const key = base32Decode(secret); if (!key) return null; const counter = Math.floor(timestamp / 30000); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter)); const digest = crypto.createHmac('sha1', key).update(b).digest(); const offset = digest.at(-1) & 15; const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0'); return code;
}
function validTotp(secret, otp) { if (!/^\d{6}$/.test(String(otp))) return false; for (let skew = -1; skew <= 1; skew++) { const code = totp(secret, Date.now() + skew * 30000); if (code && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(String(otp)))) return true; } return false; }
function tokyoDate(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function tokyoDateBoundary(value, end = false) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const timestamp = Date.parse(`${date}T00:00:00+09:00`);
  if (Number.isNaN(timestamp)) return NaN;
  // Date.parse normalizes impossible dates (for example 2026-02-30).  Keep
  // the API's date filters strict by checking the JST calendar round-trip.
  if (tokyoDate(timestamp) !== date) return NaN;
  return end ? timestamp + 86400000 : timestamp;
}
function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  return `${local.length > 1 ? `${local[0]}***` : '***'}${value.slice(at)}`;
}
function maskPhone(phone) {
  const value = String(phone || '');
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
function maskProviderId(value) {
  const text = String(value || '');
  if (!text) return null;
  return text.length <= 8 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-4)}`;
}
// Admin user responses are intentionally built from this allowlist.  Never
// spread the backing user record: it contains password material, birth date,
// sessions and other fields that must not cross the admin API boundary.
function adminUserListDto(user, role = 'viewer') {
  const owner = role === 'owner';
  return {
    id: user.id,
    email: owner ? user.email : maskEmail(user.email),
    phone: owner ? (user.phone || '') : maskPhone(user.phone),
    status: user.status || 'active',
    createdAt: user.createdAt || null,
    points: Number(user.points) || 0
  };
}
function birthDateIssue(date, now = Date.now()) {
  const value = String(date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid';
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 'invalid';
  const today = tokyoDate(now);
  if (value > today) return 'future';
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  let age = todayYear - year;
  if (todayMonth < month || (todayMonth === month && todayDay < day)) age--;
  return age >= 18 ? null : 'underage';
}
export function ageAtLeast18(date, now = Date.now()) { return birthDateIssue(date, now) === null; }

function hashDraw(previousHash, draw) {
  return crypto.createHash('sha256').update(JSON.stringify({ previousHash, ...draw })).digest('hex');
}

export class Store {
  constructor(file = DATA_FILE, options = {}) {
    this.file = file;
    this.state = this.load();
    for (const key of ['addresses', 'shipments', 'shipmentItems', 'effectRanks', 'effectVideos', 'adminUsers', 'adminSessions', 'adminAuditLogs', 'payments', 'bankTransfers', 'announcements']) this.state[key] ||= [];
    this.state.siteSettings ||= {};
    this.paymentProvider = options.paymentProvider || null;
    for (const pack of this.state.packs) {
      pack.status ||= 'selling'; pack.displayOrder ??= this.state.packs.indexOf(pack);
      if (['selling', 'sold_out'].includes(pack.status)) pack.saleStartedAt ||= pack.createdAt || new Date().toISOString();
      pack.totalSlots = Number.isInteger(pack.totalSlots) ? pack.totalSlots : this.state.packSlots.filter(s => s.packId === pack.id).length;
      pack.configuredSlots ??= this.state.packSlots.filter(s => s.packId === pack.id).length;
      if (!Array.isArray(pack.slotRows) || !pack.slotRows.length) {
        const grouped = new Map(); for (const slot of this.state.packSlots.filter(s=>s.packId===pack.id)) { const key=`${slot.cardId}\u0000${slot.effectRank||''}`; const row=grouped.get(key); if(row) row.count++; else grouped.set(key,{cardId:slot.cardId,count:1,effectRank:slot.effectRank||null}); }
        pack.slotRows=[...grouped.values()];
      }
    }
    // Older stores had no inventoryQuantity.  Existing pack slots are already
    // authoritative reservations, so retain them and provide a generous
    // migration default for legacy cards whose physical stock was not tracked.
    for (const card of this.state.cards) {
      const reserved=reservedCardCount(this.state,card.id);
      const hasInventory = card.inventoryQuantity !== undefined && card.inventoryQuantity !== null && card.inventoryQuantity !== '';
      const parsedInventory = hasInventory ? Number(card.inventoryQuantity) : NaN;
      if (Number.isSafeInteger(parsedInventory)) card.inventoryQuantity = Math.max(0, parsedInventory, reserved);
      else card.inventoryQuantity = Math.max(reserved, 1000000);
    }
    this.migrateAdminModel();
    this.ensureDevelopmentDemoUser();
    this.lock = Promise.resolve();
  }
  ensureDevelopmentDemoUser() {
    if (process.env.ADMIN_ENV === 'production' || this.state.users.some(user => user.email === 'demo@example.com')) return;
    const credentials = passwordHash('demo-user-password');
    const createdAt = new Date().toISOString();
    const user = { id:'usr_demo', email:'demo@example.com', phone:'', birthDate:'1990-01-01', passwordSalt:credentials.salt, passwordHash:credentials.hash, points:10000, role:'user', status:'active', createdAt };
    this.state.users.push(user);
    this.state.pointTransactions.push({ id:id('ptx'), userId:user.id, amount:10000, balanceAfter:10000, type:'demo_seed', metadata:{}, createdAt });
    this.persist();
  }
  migrateAdminModel() {
    const legacy = this.state.users.find(u => u.role === 'admin' || u.email === 'admin@example.com');
    if (!legacy) return;
    legacy.role = 'owner';
    if (!this.state.adminUsers.some(a => a.userId === legacy.id)) {
      if (process.env.ADMIN_ENV === 'production' && !process.env.ADMIN_2FA_SECRET) throw new Error('ADMIN_2FA_SECRET is required for initial production admin setup');
      const secret = process.env.ADMIN_2FA_SECRET || DEFAULT_DEV_TOTP_SECRET;
      const allowedIps = String(process.env.ADMIN_ALLOWED_IPS || '').split(',').map(x => x.trim()).filter(Boolean);
      this.state.adminUsers.push({ id: id('adm'), userId: legacy.id, email: legacy.email, role: 'owner', allowedIps, twoFactorSecretEnc: encryptSecret(secret), twoFactorEnabled: true, createdAt: new Date().toISOString() });
      this.persist();
    }
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { const state = emptyState(); seedDemo(state); this.persist(state); return state; }
  }
  persist(state = this.state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  async atomic(fn) {
    const run = this.lock.then(async () => {
      const before = clone(this.state);
      try { const result = await fn(this.state); this.persist(); return result; }
      catch (error) { this.state = before; throw error; }
    });
    this.lock = run.catch(() => {});
    return run;
  }
  register({ email, password, birthDate, ageConfirmed, phone = '' }) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email');
    if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
    const birthIssue = birthDateIssue(birthDate);
    if (birthIssue === 'invalid') { const error = new Error('valid birthDate'); error.code = 'invalid_birth_date'; error.userMessage = '実在する生年月日を入力してください'; throw error; }
    if (birthIssue === 'future') { const error = new Error('valid birthDate'); error.code = 'future_birth_date'; error.userMessage = '未来の日付は入力できません'; throw error; }
    if (birthIssue === 'underage') { const error = new Error('valid birthDate'); error.code = 'underage'; error.userMessage = 'このサービスは18歳未満の方は利用できません'; throw error; }
    if (!ageConfirmed) { const error = new Error('age confirmation is required'); error.code = 'age_confirmation_required'; error.userMessage = '「私は18歳以上です」にチェックしてください'; throw error; }
    email = email.trim().toLowerCase();
    if (this.state.users.some(u => u.email === email)) throw new Error('email already registered');
    const userId = id('usr'); const p = passwordHash(password);
    const normalizedPhone = phone == null ? '' : String(phone).trim();
    if (normalizedPhone.length > 40) throw new Error('invalid phone');
    this.state.users.push({ id: userId, email, phone: normalizedPhone, birthDate, passwordSalt: p.salt, passwordHash: p.hash, points: 0, role: 'user', status: 'active', createdAt: new Date().toISOString() });
    this.persist();
    return this.state.users.at(-1);
  }
  login(email, password) {
    const user = this.state.users.find(u => u.email === String(email).trim().toLowerCase());
    if (!user || !passwordMatches(password, user) || user.status === 'frozen' || user.status === 'deleted') throw new Error('invalid credentials');
    if (this.state.adminUsers.some(a => a.userId === user.id)) throw new Error('admin account must use /admin');
    const token = crypto.randomBytes(32).toString('base64url');
    this.state.sessions = this.state.sessions.filter(s => s.userId !== user.id);
    this.state.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    this.persist();
    return { token, user: publicUser(user) };
  }
  adminLogin(email, password, otp, { ip = 'unknown', environment = process.env.ADMIN_ENV || 'development' } = {}) {
    const admin = this.state.adminUsers.find(a => a.email === String(email).trim().toLowerCase()); const user = admin && this.state.users.find(u => u.id === admin.userId);
    if (!admin || !user || user.status === 'frozen' || user.status === 'deleted' || !passwordMatches(password, user) || !admin.twoFactorEnabled) throw new Error('invalid admin credentials');
    if (admin.allowedIps?.length && !admin.allowedIps.includes(ip)) throw new Error('admin IP not allowed');
    const secret = decryptSecret(admin.twoFactorSecretEnc); if (!secret || !validTotp(secret, otp)) throw new Error('2FA verification required');
    const token = crypto.randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.state.adminSessions = this.state.adminSessions.filter(s => s.adminUserId !== admin.id); this.state.adminSessions.push({ token, adminUserId: admin.id, userId: user.id, ip, environment, createdAt: new Date().toISOString(), expiresAt }); this.persist();
    return { token, expiresAt, environment, user: { ...publicUser(user), role: admin.role } };
  }
  adminForToken(token, { ip = 'unknown', environment = process.env.ADMIN_ENV || 'development' } = {}) {
    const session = this.state.adminSessions.find(s => s.token === token); if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now() || session.environment !== environment || (session.ip !== 'unknown' && session.ip !== ip)) { this.state.adminSessions = this.state.adminSessions.filter(s => s !== session); this.persist(); return null; }
    const admin = this.state.adminUsers.find(a => a.id === session.adminUserId); const user = admin && this.state.users.find(u => u.id === admin.userId); return admin && user ? { ...admin, user } : null;
  }
  adminLogout(token) { this.state.adminSessions = this.state.adminSessions.filter(s => s.token !== token); this.persist(); }
  appendAudit({ actor, action, target, before = null, after = null, ip = 'unknown', reason = '' }, { persist = true } = {}) {
    if (!actor || !action || !target) throw new Error('audit fields required');
    const entry = { id: id('audit'), actor: typeof actor === 'string' ? actor : actor.id, action, target, before: before == null ? null : clone(before), after: after == null ? null : clone(after), ip, reason: String(reason || ''), createdAt: new Date().toISOString() };
    this.state.adminAuditLogs.push(entry); if (persist) this.persist(); return entry;
  }
  adminUser(email) { return this.state.adminUsers.find(a => a.email === String(email).trim().toLowerCase()); }
  createAdminUser({ email, password, role = 'viewer', birthDate = '1980-01-01' } = {}) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 8 || !['owner', 'operator', 'viewer'].includes(role)) throw new Error('invalid admin user');
    if (this.state.adminUsers.some(a => a.email === email) || this.state.users.some(u => u.email === email)) throw new Error('email already registered');
    const userId = id('usr'); const p = passwordHash(password); const user = { id: userId, email, phone: '', birthDate, passwordSalt: p.salt, passwordHash: p.hash, points: 0, role, status: 'active', createdAt: new Date().toISOString() }; this.state.users.push(user);
    const secret = randomBase32(); const admin = { id: id('adm'), userId, email, role, allowedIps: [], twoFactorSecretEnc: encryptSecret(secret), twoFactorEnabled: true, createdAt: new Date().toISOString() }; this.state.adminUsers.push(admin); this.persist();
    return { ...admin, user: publicUser(user), twoFactorSecret: secret, twoFactorSecretEnc: undefined };
  }
  provisionAdminTwoFactor(adminId) { const admin = this.state.adminUsers.find(a => a.id === adminId); if (!admin) throw new Error('admin not found'); const secret = randomBase32(); admin.twoFactorSecretEnc = encryptSecret(secret); admin.twoFactorEnabled = true; this.persist(); return { id: admin.id, secret }; }
  setAdminIpAllowlist(adminId, allowedIps) { const admin = this.state.adminUsers.find(a => a.id === adminId); if (!admin || !Array.isArray(allowedIps) || allowedIps.some(ip => typeof ip !== 'string' || ip.length > 64)) throw new Error('invalid IP allowlist'); admin.allowedIps = [...new Set(allowedIps)]; this.persist(); return { ...admin, twoFactorSecretEnc: undefined }; }
  userForToken(token) {
    const session = this.state.sessions.find(s => s.token === token);
    if (session && session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) { this.state.sessions = this.state.sessions.filter(s => s !== session); this.persist(); return null; }
    const user = session ? (this.state.users.find(u => u.id === session.userId) || null) : null;
    return user && user.status !== 'frozen' && user.status !== 'deleted' ? user : null;
  }
  logout(token) { this.state.sessions = this.state.sessions.filter(s => s.token !== token); this.persist(); }
  addPoints(userId, amount, type = 'admin_grant', metadata = {}) {
    if (!Number.isInteger(amount) || amount === 0) throw new Error('amount must be a non-zero integer');
    const user = this.state.users.find(u => u.id === userId); if (!user) throw new Error('user not found');
    if (user.points + amount < 0) throw new Error('insufficient points');
    user.points += amount;
    this.state.pointTransactions.push({ id: id('ptx'), userId, amount, balanceAfter: user.points, type, metadata, createdAt: new Date().toISOString() });
    return user.points;
  }
  async adjustPointsByAdmin({ userId, amount, reason, adminId, ip = 'unknown' } = {}) {
    return this.atomic(state => {
      if (!Number.isInteger(amount) || amount === 0) throw new Error('amount must be a non-zero integer');
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('operation reason is required');
      const user = state.users.find(u => u.id === userId && u.role === 'user'); if (!user) throw new Error('user not found');
      const before = user.points;
      if (before + amount < 0) throw new Error('insufficient points');
      user.points += amount;
      const now = new Date().toISOString();
      const transaction = { id: id('ptx'), userId, amount, balanceBefore: before, balanceAfter: user.points, type: 'admin_operation', metadata: { adminId, reason: reason.trim() }, createdAt: now };
      state.pointTransactions.push(transaction);
      this.appendAudit({ actor: adminId, action: 'points.adjust', target: `user:${userId}`, before: { points: before }, after: { points: user.points }, ip, reason: reason.trim() }, { persist: false });
      return { balance: user.points, transaction };
    });
  }
  searchUsers({ q = '', email = '', userId = '', id: idValue = '', phone = '' } = {}) {
    const terms = [q, email, userId || idValue, phone].map(value => String(value || '').trim());
    if (terms.some(value => value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('invalid user search query');
    const normalized = terms.map(value => value.toLowerCase());
    if (!normalized.some(Boolean)) return this.state.users.filter(u => u.role === 'user');
    return this.state.users.filter(u => {
      if (u.role !== 'user') return false;
      const values = [u.email, u.id, u.phone || ''].map(value => String(value).toLowerCase());
      return normalized.every(term => !term || values.some(value => value.includes(term)));
    });
  }
  adminUserListDto(user, role = 'viewer') {
    if (!['owner', 'operator', 'viewer'].includes(role)) throw new Error('invalid admin role');
    if (!user || user.role !== 'user') throw new Error('user not found');
    return adminUserListDto(user, role);
  }
  userDetails(userId) {
    const user = this.state.users.find(u => u.id === userId && u.role === 'user'); if (!user) throw new Error('user not found');
    const draws = this.state.draws.filter(d => d.userId === userId);
    const userCards = this.state.userCards.filter(c => c.userId === userId).map(c => ({ ...c, card: publicCard(this.state.cards.find(card => card.id === c.cardId)) }));
    const shipments = this.listShipments({ userId });
    return { user: { ...publicUser(user), phone: user.phone || '', status: user.status || 'active', createdAt: user.createdAt }, points: user.points, pointTransactions: this.state.pointTransactions.filter(t => t.userId === userId), draws, userCards, shipments };
  }
  adminUserDetail(userId, { role = 'viewer', page = 1, pageSize = 50, paymentsPage = page, drawsPage = page, cardsPage = page, pointsPage = page, shipmentsPage = page } = {}) {
    if (!['owner', 'operator', 'viewer'].includes(role)) throw new Error('invalid admin role');
    const user = this.state.users.find(item => item.id === userId && item.role === 'user');
    if (!user) throw new Error('user not found');
    const paginate = (items, requestedPage = 1, requestedSize = pageSize) => {
      const safePageSize = Math.min(100, Math.max(1, Number.isInteger(Number(requestedSize)) ? Number(requestedSize) : 50));
      const requested = Math.max(1, Number.isInteger(Number(requestedPage)) ? Number(requestedPage) : 1);
      const sorted = items.slice().sort((a, b) => String(b.createdAt || b.obtainedAt || '').localeCompare(String(a.createdAt || a.obtainedAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
      const totalPages = Math.max(1, Math.ceil(sorted.length / safePageSize));
      const safePage = Math.min(requested, totalPages);
      return { items: sorted.slice((safePage - 1) * safePageSize, safePage * safePageSize), page: safePage, pageSize: safePageSize, total: sorted.length, totalPages };
    };
    const billing = this.adminBilling({ role, userId, page: paymentsPage, pageSize });
    const paymentSummary = billing.summary;
    const drawTransactions = this.state.pointTransactions.filter(item => item.userId === userId && item.type === 'draw' && item.metadata?.packId);
    const userDraws = this.state.draws.filter(item => item.userId === userId).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const drawsByTransaction = [];
    const cursors = new Map();
    for (const transaction of drawTransactions.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)))) {
      const packId = String(transaction.metadata.packId);
      const quantity = Math.max(1, Number(transaction.metadata.quantity) || 1);
      const candidates = userDraws.filter(draw => draw.packId === packId);
      const cursor = cursors.get(packId) || 0;
      const selected = candidates.slice(cursor, cursor + quantity);
      cursors.set(packId, cursor + selected.length);
      const pack = this.state.packs.find(item => item.id === packId);
      drawsByTransaction.push({ id: transaction.id, createdAt: transaction.createdAt, packId, packName: pack?.name || '不明なパック', quantity, spentPoints: Math.abs(Number(transaction.amount) || 0), cards: selected.map(draw => ({ id: draw.cardId, name: this.state.cards.find(card => card.id === draw.cardId)?.name || '不明なカード', rarity: draw.rarity, drawId: draw.id })) });
    }
    // Include every draw that could not be associated with a modern point
    // transaction.  A user can have mixed modern/legacy data during a
    // migration; checking only `!drawTransactions.length` would silently
    // drop the legacy portion.
    const assignedDrawIds = new Set(drawsByTransaction.flatMap(row => row.cards.map(card => card.drawId).filter(Boolean)));
    for (const draw of userDraws) if (!assignedDrawIds.has(draw.id)) {
      const pack = this.state.packs.find(item => item.id === draw.packId); const card = this.state.cards.find(item => item.id === draw.cardId);
      drawsByTransaction.push({ id: draw.id, createdAt: draw.createdAt, packId: draw.packId, packName: pack?.name || '不明なパック', quantity: 1, spentPoints: Number(pack?.pricePoints) || 0, cards: [{ id: draw.cardId, name: card?.name || '不明なカード', rarity: draw.rarity, drawId: draw.id }] });
    }
    const draws = paginate(drawsByTransaction, drawsPage, pageSize);
    const userCardRows = this.state.userCards.filter(item => item.userId === userId).map(item => {
      const draw = this.state.draws.find(record => record.id === item.drawId); const card = this.state.cards.find(record => record.id === item.cardId); const pack = draw && this.state.packs.find(record => record.id === draw.packId);
      return { id: item.id, cardId: item.cardId, card: publicCard(card), packId: draw?.packId || null, packName: pack?.name || '不明なパック', obtainedAt: item.obtainedAt || draw?.createdAt || null, status: item.status };
    });
    const userCards = paginate(userCardRows, cardsPage, pageSize);
    const pointRows = this.state.pointTransactions.filter(item => item.userId === userId).map(item => {
      const row = { id: item.id, createdAt: item.createdAt, type: item.type, amount: item.amount, balanceBefore: item.balanceBefore ?? null, balanceAfter: item.balanceAfter ?? null };
      const metadata = item.metadata || {};
      const allowed = {};
      for (const key of ['packId', 'quantity', 'planId', 'paymentId', 'transferId']) if (metadata[key] !== undefined) allowed[key] = metadata[key];
      if (Object.keys(allowed).length) row.metadata = allowed;
      if (role === 'viewer') { delete row.id; delete row.metadata; }
      return row;
    });
    const pointTransactions = paginate(pointRows, pointsPage, pageSize);
    const shipmentRows = this.listShipments({ userId }).map(shipment => ({
      id: shipment.id, createdAt: shipment.createdAt, status: shipment.status, trackingNumber: shipment.trackingNumber || null,
      cards: (shipment.cards || []).map(item => ({ userCardId: item.userCardId, card: item.card ? publicCard(item.card) : null }))
    }));
    const shipments = paginate(shipmentRows, shipmentsPage, pageSize);
    const publicUserDetail = {
      id: user.id,
      email: role === 'owner' ? user.email : maskEmail(user.email),
      phone: role === 'owner' ? (user.phone || '') : maskPhone(user.phone),
      status: user.status || 'active',
      createdAt: user.createdAt,
      points: user.points
    };
    const mapPayment = payment => {
      const item = { ...payment };
      if (role === 'viewer') {
        for (const key of ['id', 'userId', 'provider', 'providerPaymentId', 'paymentMethod', 'metadata']) delete item[key];
      } else if (role === 'operator') {
        item.email = maskEmail(user.email); item.providerPaymentId = maskProviderId(item.providerPaymentId);
      }
      return item;
    };
    const summary = {
      gross: paymentSummary.gross, refunds: paymentSummary.refunds, net: paymentSummary.net,
      paymentCount: paymentSummary.successCount, drawCount: drawsByTransaction.reduce((sum, row) => sum + row.quantity, 0),
      spentPoints: drawsByTransaction.reduce((sum, row) => sum + row.spentPoints, 0), obtainedCardCount: userCardRows.length
    };
    const viewerCard = card => card ? { name: card.name, rarity: card.rarity, imageUrl: card.imageUrl, redeemPoints: card.redeemPoints } : null;
    const redactDraw = row => role === 'owner' ? row : { createdAt: row.createdAt, packName: row.packName, quantity: row.quantity, spentPoints: row.spentPoints, cards: row.cards.map(card => ({ name: card.name, rarity: card.rarity })) };
    const redactCard = row => role === 'owner' ? row : { card: viewerCard(row.card), packName: row.packName, obtainedAt: row.obtainedAt, status: row.status };
    const redactShipment = row => role === 'owner' ? row : { createdAt: row.createdAt, status: row.status, trackingNumber: row.trackingNumber ? maskProviderId(row.trackingNumber) : null, cards: row.cards.map(card => ({ card: viewerCard(card.card) })) };
    return { user: publicUserDetail, summary, payments: { ...billing, payments: billing.payments.map(mapPayment) }, draws: { ...draws, items: draws.items.map(redactDraw) }, userCards: { ...userCards, items: userCards.items.map(redactCard) }, pointTransactions, shipments: { ...shipments, items: shipments.items.map(redactShipment) } };
  }
  async setUserStatus(userId, status, { adminId, ip = 'unknown', reason } = {}) {
    return this.atomic(state => {
      if (status === 'withdrawn') status = 'deleted';
      if (!['active', 'frozen', 'deleted'].includes(status)) throw new Error('invalid user status');
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('operation reason is required');
      const user = state.users.find(u => u.id === userId && u.role === 'user'); if (!user) throw new Error('user not found');
      const before = user.status || 'active'; if (before === 'deleted' && status !== 'deleted') throw new Error('deleted user cannot be restored');
      user.status = status; if (status === 'deleted') user.deletedAt = new Date().toISOString();
      if (status !== 'active') state.sessions = state.sessions.filter(s => s.userId !== userId);
      this.appendAudit({ actor: adminId, action: `user.${status === 'frozen' ? 'freeze' : status === 'active' ? 'unfreeze' : 'delete'}`, target: `user:${userId}`, before: { status: before }, after: { status }, ip, reason: reason.trim() }, { persist: false });
      return this.userDetails(userId);
    });
  }
  async freezeUser(userId, options = {}) { return this.setUserStatus(userId, 'frozen', options); }
  async unfreezeUser(userId, options = {}) { return this.setUserStatus(userId, 'active', options); }
  async withdrawUser(userId, options = {}) { return this.setUserStatus(userId, 'deleted', options); }
  adminInventory() {
    return this.state.packs.map(pack => {
      const slots = this.state.packSlots.filter(s => s.packId === pack.id);
      const remaining = slots.filter(s => !s.drawnAt);
      const rareRemaining = {};
      for (const slot of remaining) if (!['N', 'R'].includes(slot.rarity)) rareRemaining[slot.rarity] = (rareRemaining[slot.rarity] || 0) + 1;
      return { id: pack.id, slug: pack.slug, name: pack.name, status: pack.status, totalSlots: pack.totalSlots ?? slots.length, configuredSlots: slots.length, remaining: remaining.length, rareRemaining, rareRemainingByRarity: rareRemaining };
    });
  }
  adminCards() {
    return this.state.cards.map(card => {
      const totalInventory = cardInventoryQuantity(card);
      const reservedQuantity = reservedCardCount(this.state, card.id);
      const issuedQuantity = this.state.userCards.filter(item => item.cardId === card.id).length;
      return { ...clone(card), inventoryQuantity: totalInventory, totalInventory, poolQuantity: Math.max(0, totalInventory - reservedQuantity), reservedQuantity, gachaAssignedQuantity: reservedQuantity, issuedQuantity };
    });
  }
  searchDraws({ userId = '', packId = '', from = '', to = '', rarity = '' } = {}) {
    const fromMs = from ? Date.parse(from) : NaN; const toMs = to ? Date.parse(to) : NaN;
    return this.state.draws.filter(draw => {
      const at = Date.parse(draw.createdAt);
      return (!userId || draw.userId === userId) && (!packId || draw.packId === packId) && (!rarity || draw.rarity === rarity) && (Number.isNaN(fromMs) || at >= fromMs) && (Number.isNaN(toMs) || at <= toMs);
    });
  }
  detectDrawAnomalies({ windowMs = 24 * 60 * 60 * 1000, minHighValue = 1000, threshold = 3 } = {}) {
    const now = Date.now(); const byUser = new Map();
    for (const draw of this.state.draws) { if (Date.parse(draw.createdAt) < now - windowMs) continue; const card = this.state.cards.find(c => c.id === draw.cardId); if (!card || card.redeemPoints < minHighValue) continue; const list = byUser.get(draw.userId) || []; list.push(draw); byUser.set(draw.userId, list); }
    return [...byUser].filter(([, draws]) => draws.length >= threshold).map(([userId, draws]) => ({ userId, count: draws.length, drawIds: draws.map(d => d.id), windowMs, minHighValue }));
  }
  async draw(userId, packId, quantity = 1) {
    return this.atomic(state => {
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity must be a positive integer');
      const user = state.users.find(u => u.id === userId); const pack = state.packs.find(p => p.id === packId);
      if (!user || !pack) throw new Error('user or pack not found');
      if (pack.status === 'scheduled' && Date.parse(pack.startsAt) <= Date.now()) { pack.status = 'selling'; pack.saleStartedAt ||= new Date().toISOString(); }
      if (pack.status !== 'selling') throw new Error('pack is not available');
      const available = state.packSlots.filter(s => s.packId === packId && !s.drawnAt);
      if (available.length < quantity) throw new Error(`only ${available.length} slot(s) remain`);
      if (quantity > 1000) throw new Error('quantity exceeds limit');
      const cost = pack.pricePoints * quantity;
      if (user.points < cost) throw new Error('insufficient points');
      user.points -= cost;
      state.pointTransactions.push({ id: id('ptx'), userId, amount: -cost, balanceAfter: user.points, type: 'draw', metadata: { packId, quantity }, createdAt: new Date().toISOString() });
      const results = [];
      for (let i = 0; i < quantity; i++) {
        const remainingBefore = available.length;
        const index = crypto.randomInt(available.length);
        const slot = available.splice(index, 1)[0];
        slot.drawnAt = new Date().toISOString(); slot.drawnBy = userId;
        const card = state.cards.find(c => c.id === slot.cardId);
        if (!card || !Number.isInteger(card.inventoryQuantity) || card.inventoryQuantity < 1) throw new Error('reserved card inventory is inconsistent');
        card.inventoryQuantity--;
        const previousHash = state.draws.at(-1)?.hash || null;
        const drawData = { id: id('drw'), userId, packId, slotId: slot.id, cardId: card.id, rarity: card.rarity, remainingBefore, remainingAfter: remainingBefore - 1, createdAt: slot.drawnAt };
        const draw = { ...drawData, previousHash, hash: hashDraw(previousHash, drawData) };
        state.draws.push(draw);
        const userCard = { id: id('uc'), userId, cardId: card.id, drawId: draw.id, status: 'unprocessed', obtainedAt: slot.drawnAt };
        state.userCards.push(userCard);
        const effectRank = slot.effectRank || card.rarity;
        const fallbackRank = state.effectRanks?.find(r=>r.name===effectRank)?.fallbackRank;
        const effect = state.effectVideos?.find(e => e.rarity === effectRank && e.url) || (fallbackRank && state.effectVideos?.find(e=>e.rarity===fallbackRank && e.url)) || state.effectVideos?.find(e => e.fallback && e.url) || null;
        results.push({ draw, card: publicCard(card), userCard, effect: effect ? { rarity: effect.rarity, url: effect.url, label: effect.label } : { rarity: effectRank, url: null, label: 'default animation' } });
      }
      if (!state.packSlots.some(s => s.packId === packId && !s.drawnAt)) pack.status = 'sold_out';
      return { balance: user.points, results };
    });
  }
  async redeem(userId, userCardId) {
    return this.redeemMany(userId, [userCardId]);
  }
  async redeemMany(userId, userCardIds) {
    return this.atomic(state => {
      if (!Array.isArray(userCardIds) || userCardIds.length < 1 || userCardIds.length > 1000) throw new Error('invalid card list');
      if (new Set(userCardIds).size !== userCardIds.length) throw new Error('duplicate card ids');
      const owned = userCardIds.map(cardId => state.userCards.find(c => c.id === cardId && c.userId === userId));
      if (owned.some(c => !c)) throw new Error('card not found');
      if (owned.some(c => c.status !== 'unprocessed')) throw new Error('card is not redeemable');
      const user = state.users.find(u => u.id === userId); const cards = owned.map(c => state.cards.find(x => x.id === c.cardId));
      const total = cards.reduce((sum, c) => sum + c.redeemPoints, 0); owned.forEach(c => { c.status = 'redeemed'; c.redeemedAt = new Date().toISOString(); });
      this.addPoints(userId, total, 'redemption', { userCardIds });
      return { balance: user.points, userCards: owned, cards: cards.map(publicCard) };
    });
  }
  async addAddress(userId, address) { return this.atomic(state => { if (!address || !address.name || !address.postalCode || !address.prefecture || !address.city || !address.line1) throw new Error('complete address required'); const { name, postalCode, prefecture, city, line1, line2 = '', phone = '', isDefault = false } = address; if (isDefault) state.addresses.filter(a => a.userId === userId).forEach(a => { a.isDefault = false; }); const item={id:id('addr'),userId,name,postalCode,prefecture,city,line1,line2,phone,isDefault:Boolean(isDefault),createdAt:new Date().toISOString()}; state.addresses.push(item); return item; }); }
  async createShipment(userId, userCardIds, addressId) { return this.atomic(state => { if(!Array.isArray(userCardIds)||!userCardIds.length||new Set(userCardIds).size!==userCardIds.length) throw new Error('invalid or duplicate card list'); const address=state.addresses.find(a=>a.id===addressId&&a.userId===userId); if(!address)throw new Error('address not found'); const cards=userCardIds.map(cardId=>state.userCards.find(c=>c.id===cardId&&c.userId===userId)); if(cards.some(c=>!c))throw new Error('card not found'); if(cards.some(c=>c.status!=='unprocessed'))throw new Error('card is not shippable'); const shipment={id:id('shp'),userId,addressId,status:'requested',createdAt:new Date().toISOString()}; state.shipments.push(shipment); cards.forEach(c=>{c.status='shipping_requested'; state.shipmentItems.push({id:id('shi'),shipmentId:shipment.id,userCardId:c.id});}); return {...shipment,userCardIds}; }); }
  async updateShipment(shipmentId, { status, trackingNumber } = {}) {
    return this.atomic(state => {
      const allowed = new Set(['requested', 'processing', 'shipped', 'canceled']);
      if (!allowed.has(status)) throw new Error('invalid shipment status');
      if (trackingNumber !== undefined && (typeof trackingNumber !== 'string' || trackingNumber.length > 100)) throw new Error('invalid tracking number');
      const shipment = state.shipments.find(item => item.id === shipmentId);
      if (!shipment) throw new Error('shipment not found');
      if (shipment.status === 'shipped' && status !== 'shipped') throw new Error('shipped shipment cannot change status');
      if (shipment.status === 'canceled' && status !== 'canceled') throw new Error('canceled shipment cannot change status');
      shipment.status = status;
      if (trackingNumber !== undefined) shipment.trackingNumber = trackingNumber.trim() || null;
      const items = state.shipmentItems.filter(item => item.shipmentId === shipment.id);
      const cards = items.map(item => state.userCards.find(card => card.id === item.userCardId)).filter(Boolean);
      if (status === 'shipped') cards.forEach(card => { card.status = 'shipped'; card.shippedAt ||= new Date().toISOString(); });
      if (status === 'canceled') cards.forEach(card => { if (card.status === 'shipping_requested') card.status = 'unprocessed'; });
      return { ...shipment, userCardIds: items.map(item => item.userCardId) };
    });
  }
  listShipments({ status = '', userId = '' } = {}) {
    return this.state.shipments.filter(s => (!status || s.status === status) && (!userId || s.userId === userId)).map(s => {
      const address = this.state.addresses.find(a => a.id === s.addressId);
      const items = this.state.shipmentItems.filter(i => i.shipmentId === s.id);
      const cards = items.map(i => { const uc=this.state.userCards.find(c=>c.id===i.userCardId); const card=uc&&this.state.cards.find(c=>c.id===uc.cardId); return { userCardId:i.userCardId, card:card ? publicCard(card) : null }; });
      return clone({ ...s, address: address ? {...address} : null, items, cards });
    });
  }
  setPaymentProvider(provider) { this.paymentProvider = provider || null; return this.paymentProvider; }
  listPayments(userId = '') { return clone(this.state.payments.filter(p => !userId || p.userId === userId).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))); }
  adminBilling({ role = 'viewer', from = '', to = '', status = '', method = '', provider = '', userId = '', email = '', page = 1, pageSize = 50 } = {}) {
    if (!['owner', 'operator', 'viewer'].includes(role)) throw new Error('invalid admin role');
    const fromMs = from ? tokyoDateBoundary(from) : NaN;
    const toMs = to ? tokyoDateBoundary(to, true) : NaN;
    if ((from && Number.isNaN(fromMs)) || (to && Number.isNaN(toMs))) throw new Error('invalid billing date range');
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && fromMs >= toMs) throw new Error('invalid billing date range');
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const normalizedMethod = String(method || '').trim().toLowerCase();
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedUserId = String(userId || '').trim().toLowerCase();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (role === 'viewer' && normalizedEmail) throw new Error('email search unavailable for viewer');
    const userById = new Map(this.state.users.map(user => [user.id, user]));
    const effectivePaidAt = payment => {
      if (payment.paidAt) return { value: payment.paidAt, estimated: false };
      if (['paid', 'refunded'].includes(payment.status) && payment.createdAt) return { value: payment.createdAt, estimated: true };
      return { value: null, estimated: false };
    };
    const effectiveRefundedAt = payment => payment.refundedAt || null;
    const matchesDate = payment => {
      if (Number.isNaN(fromMs) && Number.isNaN(toMs)) return true;
      const values = [effectivePaidAt(payment).value, effectiveRefundedAt(payment), payment.createdAt].filter(Boolean).map(value => Date.parse(value)).filter(value => !Number.isNaN(value));
      return values.some(eventMs => (Number.isNaN(fromMs) || eventMs >= fromMs) && (Number.isNaN(toMs) || eventMs < toMs));
    };
    const all = this.state.payments.filter(payment => {
      const user = userById.get(payment.userId);
      // Billing is a JPY-only ledger.  Ignore any legacy/invalid non-JPY row
      // rather than mixing currencies in the totals.
      if (!user || user.role !== 'user' || String(payment.currency || '').toUpperCase() !== 'JPY' || !matchesDate(payment)) return false;
      if (normalizedStatus && String(payment.status || '').toLowerCase() !== normalizedStatus) return false;
      const paymentMethod = String(payment.paymentMethod || payment.metadata?.paymentMethod || 'unknown').toLowerCase();
      const paymentProvider = String(payment.provider || payment.metadata?.provider || (payment.stripePaymentId ? 'stripe' : 'unconfigured')).toLowerCase();
      if (normalizedMethod && paymentMethod !== normalizedMethod) return false;
      if (normalizedProvider && paymentProvider !== normalizedProvider) return false;
      if (normalizedUserId && !String(payment.userId).toLowerCase().includes(normalizedUserId)) return false;
      // Operators can search only an exact address; viewers cannot search by
      // email at all because their result is intentionally masked.
      if (normalizedEmail && String(user.email || '').toLowerCase() !== normalizedEmail) return false;
      return true;
    });
    const grossEligible = payment => ['paid', 'refunded'].includes(payment.status) && effectivePaidAt(payment).value;
    const refundEligible = payment => payment.status === 'refunded' && effectiveRefundedAt(payment);
    const inRange = value => {
      const at = Date.parse(value || '');
      return !Number.isNaN(at) && (Number.isNaN(fromMs) || at >= fromMs) && (Number.isNaN(toMs) || at < toMs);
    };
    const grossAmount = payment => grossEligible(payment) && inRange(effectivePaidAt(payment).value) ? Number(payment.amount) || 0 : 0;
    const refundAmount = payment => refundEligible(payment) && inRange(effectiveRefundedAt(payment)) ? Number(payment.amount) || 0 : 0;
    const summary = { gross: all.reduce((total, payment) => total + grossAmount(payment), 0), refunds: all.reduce((total, payment) => total + refundAmount(payment), 0), paymentCount: all.length, successCount: all.filter(payment => grossEligible(payment) && inRange(effectivePaidAt(payment).value)).length, refundCount: all.filter(payment => refundEligible(payment) && inRange(effectiveRefundedAt(payment))).length, refundPendingCount: all.filter(payment => payment.status === 'refund_pending').length };
    summary.net = summary.gross - summary.refunds;
    const byUser = new Map();
    for (const payment of all) {
      const user = userById.get(payment.userId);
      const current = byUser.get(payment.userId) || { userId: payment.userId, email: user.email, gross: 0, refunds: 0, net: 0, paymentCount: 0, refundedCount: 0, lastPaidAt: null };
      current.gross += grossAmount(payment); current.refunds += refundAmount(payment); current.net = current.gross - current.refunds; current.paymentCount += 1; if (refundEligible(payment)) current.refundedCount += 1;
      const paidAt = effectivePaidAt(payment).value; if (paidAt && (!current.lastPaidAt || Date.parse(paidAt) > Date.parse(current.lastPaidAt))) current.lastPaidAt = paidAt;
      byUser.set(payment.userId, current);
    }
    const users = [...byUser.values()].sort((a, b) => b.gross - a.gross || b.refunds - a.refunds || a.userId.localeCompare(b.userId)).map(item => role === 'viewer'
      ? { email: maskEmail(item.email), gross: item.gross, refunds: item.refunds, net: item.net, paymentCount: item.paymentCount, refundedCount: item.refundedCount, lastPaidAt: item.lastPaidAt }
      : { ...item, email: role === 'owner' ? item.email : maskEmail(item.email) });
    const sorted = all.slice().sort((a, b) => {
      const aAt = Date.parse(effectivePaidAt(a).value || effectiveRefundedAt(a) || a.createdAt || '') || 0;
      const bAt = Date.parse(effectivePaidAt(b).value || effectiveRefundedAt(b) || b.createdAt || '') || 0;
      return bAt - aAt || String(b.id).localeCompare(String(a.id));
    });
    const safePageSize = Math.min(100, Math.max(1, Number.isInteger(Number(pageSize)) ? Number(pageSize) : 50));
    const requestedPage = Math.max(1, Number.isInteger(Number(page)) ? Number(page) : 1);
    const totalPages = Math.max(1, Math.ceil(sorted.length / safePageSize));
    const safePage = Math.min(requestedPage, totalPages);
    const payments = sorted.slice((safePage - 1) * safePageSize, safePage * safePageSize).map(payment => {
      const user = userById.get(payment.userId); const paid = effectivePaidAt(payment); const paymentMethod = payment.paymentMethod || payment.metadata?.paymentMethod || null; const paymentProvider = payment.provider || payment.metadata?.provider || (payment.stripePaymentId ? 'stripe' : null);
      const providerPaymentId = payment.stripePaymentId || payment.providerPaymentId || null;
      const safe = { points: payment.points, amount: payment.amount, currency: payment.currency, status: payment.status, createdAt: payment.createdAt, updatedAt: payment.updatedAt, paidAt: paid.value, paidAtEstimated: paid.estimated, refundedAt: payment.refundedAt || null, refundAmount: refundAmount(payment), email: maskEmail(user.email) };
      if (role === 'viewer') return safe;
      return { id: payment.id, userId: payment.userId, email: role === 'owner' ? user.email : maskEmail(user.email), points: safe.points, amount: safe.amount, currency: safe.currency, status: safe.status, paymentMethod, provider: paymentProvider, providerPaymentId: role === 'owner' ? providerPaymentId : maskProviderId(providerPaymentId), createdAt: safe.createdAt, updatedAt: safe.updatedAt, paidAt: safe.paidAt, paidAtEstimated: safe.paidAtEstimated, refundedAt: safe.refundedAt, refundAmount: safe.refundAmount, metadata: payment.metadata?.planId ? { planId: String(payment.metadata.planId) } : {} };
    });
    const filters = { from: from || '', to: to || '', status: normalizedStatus, method: normalizedMethod, provider: normalizedProvider };
    if (role !== 'viewer') { filters.userId = userId || ''; filters.email = role === 'owner' ? email || '' : (normalizedEmail ? maskEmail(email) : ''); }
    return { summary, users, payments, total: sorted.length, page: safePage, pageSize: safePageSize, totalPages, filters };
  }
  adminPaymentDetail(paymentId, { role = 'viewer' } = {}) {
    if (!['owner', 'operator'].includes(role)) throw new Error('insufficient admin role');
    const payment = this.state.payments.find(item => item.id === paymentId);
    if (!payment) throw new Error('payment not found');
    const user = this.state.users.find(item => item.id === payment.userId);
    if (!user || user.role !== 'user') throw new Error('payment user not found');
    // Build the DTO directly so a detail request remains correct for accounts
    // with more than 100 payments and never exposes the backing record.
    const paidAt = payment.paidAt || (['paid', 'refunded'].includes(payment.status) ? payment.createdAt : null);
    const paymentMethod = payment.paymentMethod || payment.metadata?.paymentMethod || null;
    const paymentProvider = payment.provider || payment.metadata?.provider || (payment.stripePaymentId ? 'stripe' : null);
    const providerPaymentId = payment.stripePaymentId || payment.providerPaymentId || null;
    const publicPayment = { id:payment.id, userId:payment.userId, email:role === 'owner' ? user.email : maskEmail(user.email), points:payment.points, amount:payment.amount, currency:String(payment.currency || '').toUpperCase(), status:payment.status, paymentMethod, provider:paymentProvider, providerPaymentId:role === 'owner' ? providerPaymentId : maskProviderId(providerPaymentId), createdAt:payment.createdAt, updatedAt:payment.updatedAt, paidAt, paidAtEstimated:Boolean(!payment.paidAt && paidAt), refundedAt:payment.refundedAt || null, refundAmount:payment.status === 'refunded' ? Number(payment.refundAmount ?? payment.amount) || 0 : 0, metadata:payment.metadata?.planId ? {planId:String(payment.metadata.planId)} : {}};
    const pointTransactions = this.state.pointTransactions.filter(item => item.metadata?.paymentId === payment.id).map(item => ({ id:item.id, userId:item.userId, amount:item.amount, balanceBefore:item.balanceBefore, balanceAfter:item.balanceAfter, type:item.type, createdAt:item.createdAt }));
    // Audit before/after objects can contain provider payloads and IPs.  Only
    // owners may inspect this already-redacted allowlist.
    const auditLogs = role === 'owner' ? this.state.adminAuditLogs.filter(item => item.target === `payment:${payment.id}`).map(item => ({ id:item.id, actor:item.actor, action:item.action, target:item.target, reason:item.reason, createdAt:item.createdAt })) : [];
    return { payment:publicPayment, user:{id:user.id, email:role === 'owner' ? user.email : maskEmail(user.email)}, pointTransactions, auditLogs };
  }
  async createPayment({ userId, points, amount = 0, currency = 'JPY', stripePaymentId = null, metadata = {} } = {}) {
    points = Number(points); amount = Number(amount);
    if (!userId || !Number.isInteger(points) || points < 1 || !Number.isInteger(amount) || amount < 0) throw new Error('invalid payment');
    if (String(currency || '').toUpperCase() !== 'JPY') throw new Error('only JPY payments are supported');
    const user = this.state.users.find(item => item.id === userId && item.role === 'user');
    if (!user) throw new Error('user not found');
    if (user.status === 'frozen' || user.status === 'deleted') throw new Error('user is frozen or deleted');
    if (!ageAtLeast18(user.birthDate)) throw new Error('user must be at least 18');
    let providerResult = null;
    if (this.paymentProvider?.createPayment) providerResult = await this.paymentProvider.createPayment({ userId, points, amount, currency, metadata });
    // A client-supplied Stripe ID is only a reference; credit points after an
    // injected provider/webhook explicitly confirms success.
    const status = ['paid','succeeded','completed'].includes(providerResult?.status) ? 'paid' : 'pending';
    const payment = await this.atomic(state => {
      const createdAt = new Date().toISOString();
      const item = { id:id('pay'), userId, points, amount, currency:String(currency || 'JPY').toUpperCase(), stripePaymentId:providerResult?.id || stripePaymentId || null, status, refundStatus:null, refundAttempts:0, metadata:clone(metadata || {}), createdAt, updatedAt:createdAt, ...(status === 'paid' ? { paidAt: createdAt } : {}) };
      state.payments.push(item);
      if (status === 'paid') {
        const user=state.users.find(u=>u.id===userId); if(!user) throw new Error('user not found'); user.points += points;
        state.pointTransactions.push({id:id('ptx'),userId,amount:points,balanceAfter:user.points,type:'payment_purchase',metadata:{paymentId:item.id,stripePaymentId:item.stripePaymentId},createdAt:item.createdAt});
      }
      return clone(item);
    });
    return payment;
  }
  async markPaymentPaid(paymentId, { stripePaymentId = null, adminId = null, ip = 'unknown', reason = 'provider confirmation' } = {}) {
    return this.atomic(state => {
      const payment=state.payments.find(p=>p.id===paymentId); if(!payment) throw new Error('payment not found');
      if(payment.status==='refunded') throw new Error('refunded payment cannot be paid');
      if(payment.status==='paid') return clone(payment);
      const user=state.users.find(u=>u.id===payment.userId); if(!user) throw new Error('user not found');
      const before={status:payment.status,points:user.points}; payment.status='paid'; payment.stripePaymentId ||= stripePaymentId; payment.paidAt ||= new Date().toISOString(); payment.updatedAt=new Date().toISOString(); user.points += payment.points;
      state.pointTransactions.push({id:id('ptx'),userId:user.id,amount:payment.points,balanceAfter:user.points,type:'payment_purchase',metadata:{paymentId:payment.id,stripePaymentId:payment.stripePaymentId},createdAt:payment.updatedAt});
      if(adminId) this.appendAudit({actor:adminId,action:'payment.mark_paid',target:`payment:${payment.id}`,before,after:{status:payment.status,points:user.points},ip,reason},{persist:false});
      return clone(payment);
    });
  }
  async refundPayment(paymentId, { adminId, reason, ip = 'unknown' } = {}) {
    if (!adminId || typeof reason !== 'string' || !reason.trim()) throw new Error('operation reason is required');
    const refundProvider = this.paymentProvider?.refund || this.paymentProvider?.refundPayment;
    const marked = await this.atomic(state => {
      const payment=state.payments.find(p=>p.id===paymentId); if(!payment) throw new Error('payment not found');
      if(payment.status==='refunded') throw new Error('payment already refunded');
      if(!['paid','refund_failed','refund_pending'].includes(payment.status)) throw new Error('payment is not refundable');
      const user=state.users.find(u=>u.id===payment.userId&&u.role==='user'); if(!user) throw new Error('user not found');
      if (refundProvider && !payment.refundReserved) {
        if(user.points < payment.points) throw new Error('insufficient points for refund');
        user.points -= payment.points; const reservationId=id('ptx');
        state.pointTransactions.push({id:reservationId,userId:user.id,amount:-payment.points,balanceBefore:user.points+payment.points,balanceAfter:user.points,type:'refund_reserve',metadata:{paymentId:payment.id},createdAt:new Date().toISOString()});
        payment.refundReserved=true; payment.refundReservationTransactionId=reservationId;
      }
      payment.status='refund_pending'; payment.refundStatus='pending'; payment.refundAttempts=(payment.refundAttempts||0)+1; payment.updatedAt=new Date().toISOString(); return clone({...payment,idempotencyKey:`refund:${payment.id}`});
    });
    try {
      let providerResult = null;
      if (refundProvider) providerResult = await refundProvider.call(this.paymentProvider, marked);
      else throw new Error('payment provider unavailable; refund remains pending');
      return await this.atomic(state => {
        const payment=state.payments.find(p=>p.id===paymentId); const user=state.users.find(u=>u.id===payment.userId); if(!user) throw new Error('user not found');
        if(!payment.refundReserved) throw new Error('refund points are not reserved');
        const before={status:payment.status,points:user.points+payment.points}; payment.status='refunded'; payment.refundStatus='succeeded'; payment.refundedAt=new Date().toISOString(); payment.providerRefundId=providerResult?.id || null; payment.updatedAt=payment.refundedAt; payment.refundReserved=false;
        const reservation=state.pointTransactions.find(t=>t.id===payment.refundReservationTransactionId); if(reservation){reservation.type='refund';reservation.metadata.stripeRefundId=payment.providerRefundId;}
        this.appendAudit({actor:adminId,action:'payment.refund',target:`payment:${payment.id}`,before,after:{status:payment.status,points:user.points},ip,reason:reason.trim()},{persist:false}); return clone(payment);
      });
    } catch (error) {
      await this.atomic(state => { const payment=state.payments.find(p=>p.id===paymentId); if(payment && payment.status==='refund_pending'){ const unavailable=/provider unavailable/.test(String(error.message)); const user=state.users.find(u=>u.id===payment.userId); if(!unavailable&&payment.refundReserved&&user){user.points+=payment.points;state.pointTransactions.push({id:id('ptx'),userId:user.id,amount:payment.points,balanceBefore:user.points-payment.points,balanceAfter:user.points,type:'refund_release',metadata:{paymentId:payment.id,reservationTransactionId:payment.refundReservationTransactionId},createdAt:new Date().toISOString()});payment.refundReserved=false;} payment.status=unavailable?'refund_pending':'refund_failed'; payment.refundStatus=unavailable?'pending':'failed'; payment.refundError=String(error.message); payment.updatedAt=new Date().toISOString(); } });
      throw error;
    }
  }
  async purchasePoints(input = {}) { return this.createPayment(input); }
  async recordPayment(paymentId, options = {}) { return this.markPaymentPaid(paymentId, options); }
  async createBankTransfer({ userId = null, points, amount = 0, reference, metadata = {} } = {}) {
    points=Number(points); amount=Number(amount); reference=String(reference || '').trim();
    if(!Number.isInteger(points)||points<1||!Number.isInteger(amount)||amount<0||!reference) throw new Error('invalid bank transfer');
    return this.atomic(state => { if(state.bankTransfers.some(t=>t.reference===reference)) throw new Error('duplicate transfer reference'); const item={id:id('bank'),userId,points,amount,reference,status:'pending',metadata:clone(metadata),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; state.bankTransfers.push(item); return clone(item); });
  }
  async reconcileBankTransfer(transferId, { userId, adminId, reason, ip = 'unknown' } = {}) {
    if(!adminId || typeof reason!=='string'||!reason.trim()) throw new Error('operation reason is required');
    return this.atomic(state => { const transfer=state.bankTransfers.find(t=>t.id===transferId); if(!transfer) throw new Error('bank transfer not found'); if(transfer.status==='reconciled') throw new Error('bank transfer already reconciled'); if(!userId) userId=transfer.userId; const user=state.users.find(u=>u.id===userId&&u.role==='user'); if(!user) throw new Error('user not found'); const before={status:transfer.status,userId:transfer.userId,points:user.points}; transfer.userId=userId; transfer.status='reconciled'; transfer.reconciledAt=new Date().toISOString(); transfer.updatedAt=transfer.reconciledAt; user.points += transfer.points; state.pointTransactions.push({id:id('ptx'),userId,amount:transfer.points,balanceAfter:user.points,type:'bank_transfer',metadata:{transferId:transfer.id,reference:transfer.reference,adminId},createdAt:transfer.updatedAt}); this.appendAudit({actor:adminId,action:'bank_transfer.reconcile',target:`bank_transfer:${transfer.id}`,before,after:{status:transfer.status,userId,points:user.points},ip,reason:reason.trim()},{persist:false}); return clone(transfer); });
  }
  async updateSiteSettings(patch = {}, { adminId, reason, ip = 'unknown' } = {}) {
    if(!adminId || typeof reason!=='string'||!reason.trim()) throw new Error('operation reason is required');
    return this.atomic(state => { const allowed=['announcement','banner','presets','bonusRate','maintenance','termsMarkdown','legalMarkdown']; const before=clone(state.siteSettings); for(const key of allowed) if(patch[key]!==undefined){ if(key==='maintenance') state.siteSettings[key]=Boolean(patch[key]); else if(key==='presets') state.siteSettings[key]=Array.isArray(patch[key])?clone(patch[key]):[]; else if(typeof patch[key]!=='string'&&key!=='bonusRate') throw new Error('invalid site setting'); else state.siteSettings[key]=key==='bonusRate'?Number(patch[key]):String(patch[key]); } state.siteSettings.updatedAt=new Date().toISOString(); this.appendAudit({actor:adminId,action:'site_settings.update',target:'site_settings:global',before,after:state.siteSettings,ip,reason:reason.trim()},{persist:false}); return clone(state.siteSettings); });
  }
  async upsertAnnouncement(input = {}, { adminId, reason, ip = 'unknown' } = {}) {
    if(!adminId || typeof reason!=='string'||!reason.trim()) throw new Error('operation reason is required');
    return this.atomic(state => { const item=input.id&&state.announcements.find(a=>a.id===input.id); const before=item?clone(item):null; const target=item||{id:id('ann'),createdAt:new Date().toISOString()}; target.title=String(input.title||'').trim(); target.body=String(input.body||''); target.banner=String(input.banner||''); target.published=input.published!==false; target.updatedAt=new Date().toISOString(); if(!target.title) throw new Error('announcement title required'); if(!item) state.announcements.push(target); this.appendAudit({actor:adminId,action:item?'announcement.update':'announcement.create',target:`announcement:${target.id}`,before,after:target,ip,reason:reason.trim()},{persist:false}); return clone(target); });
  }
  dashboard({ from, to } = {}) {
    const now=Date.now(); const fromMs=from ? tokyoDateBoundary(from) : now-30*86400000; const toMs=to ? tokyoDateBoundary(to,true) : now+1;
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) throw new Error('invalid dashboard date range');
    const inRange=value=>{const at=Date.parse(value||''); return !Number.isNaN(at)&&at>=fromMs&&at<toMs;};
    const paymentAt=p=>p.paidAt||(['paid','refunded'].includes(p.status)?p.createdAt:null);
    const payments=this.state.payments.filter(p=>String(p.currency||'').toUpperCase()==='JPY'&&['paid','refunded'].includes(p.status)&&inRange(paymentAt(p)));
    const sales=payments.reduce((n,p)=>n+(p.amount||0),0); const draws=this.state.draws.filter(d=>inRange(d.createdAt));
    const spend=this.state.pointTransactions.filter(t=>t.type==='draw'&&inRange(t.createdAt)).reduce((n,t)=>n+Math.abs(t.amount),0); const payout=this.state.pointTransactions.filter(t=>t.type==='redemption'&&inRange(t.createdAt)).reduce((n,t)=>n+Math.max(0,t.amount),0);
    const byPack={}; for(const p of this.state.packs){const pt=draws.filter(d=>d.packId===p.id); byPack[p.id]={packId:p.id,name:p.name,salesPoints:pt.length*p.pricePoints,salesCount:pt.length,remaining:this.state.packSlots.filter(s=>s.packId===p.id&&!s.drawnAt).length,rareRemaining:this.adminInventory().find(x=>x.id===p.id)?.rareRemaining||{}};}
    const high=draws.map(d=>({...d,card:this.state.cards.find(c=>c.id===d.cardId)})).sort((a,b)=>(b.card?.redeemPoints||0)-(a.card?.redeemPoints||0)).slice(0,10); const pendingShipments=this.state.shipments.filter(s=>['requested','processing'].includes(s.status)).length; const redemptionRate=spend?payout/spend:0;
    return {from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString(),sales:{total:sales,daily:payments.filter(p=>inRange(paymentAt(p))&&Date.parse(paymentAt(p))>=now-86400000).reduce((n,p)=>n+(p.amount||0),0),monthly:payments.filter(p=>inRange(paymentAt(p))&&Date.parse(paymentAt(p))>=now-30*86400000).reduce((n,p)=>n+(p.amount||0),0)},revenue:sales,drawCount:draws.length,draws:draws.length,redemptionRate,payoutRatio:redemptionRate,packSales:byPack,packs:Object.values(byPack),recentHighValue:high,pendingShipments,pendingShipmentCount:pendingShipments};
  }
  getDashboard(options = {}) { return this.dashboard(options); }
  shipmentLabelCsv(options = {}) { return shipmentLabelCsv(this.listShipments(options), this.state); }
  async createPack(input = {}) {
    return this.atomic(state => {
      const slug = String(input.slug || '').trim(); const name = String(input.name || '').trim();
      const pricePoints = Number(input.pricePoints); const totalSlots = Number(input.totalSlots ?? 0);
      if (!slug || !name || !Number.isInteger(pricePoints) || pricePoints < 1 || pricePoints > 1e9) throw new Error('invalid pack');
      const rows = normalizeSlotRows(input.slots ?? input.slotRows);
      if (rows.some(row => !Number.isInteger(row.count) || row.count < 1 || row.count > 100000 || row.effectRank && !validRank(row.effectRank))) throw new Error('invalid pack slot count');
      if (rows.some(row => !state.cards.some(card => card.id === row.cardId))) throw new Error('card not found');
      if (Array.isArray(input.featuredCardIds) && input.featuredCardIds.some(cardId=>!state.cards.some(c=>c.id===cardId))) throw new Error('card not found');
      const configuredSlots = rows.reduce((sum, row) => sum + row.count, 0);
      const resolvedTotal = totalSlots || configuredSlots;
      if (!Number.isInteger(resolvedTotal) || resolvedTotal < 1 || resolvedTotal > 100000 || configuredSlots > resolvedTotal) throw new Error('invalid total slot count');
      const needed = new Map(); for (const row of rows) needed.set(row.cardId, (needed.get(row.cardId) || 0) + row.count);
      for (const [cardId, count] of needed) {
        const card = state.cards.find(item => item.id === cardId);
        if (Math.max(0, cardInventoryQuantity(card) - reservedCardCount(state, cardId)) < count) throw new Error('insufficient pool card inventory');
      }
      const idValue = id('pack'); const status = input.status || 'draft';
      if (!PACK_STATUSES.has(status) || status === 'selling' && configuredSlots !== resolvedTotal) throw new Error('invalid pack status or incomplete configuration');
      if (status === 'scheduled' && (!input.startsAt || Number.isNaN(Date.parse(input.startsAt)))) throw new Error('scheduled pack requires startsAt');
      const pack = { id:idValue, slug, name, pricePoints, totalSlots:resolvedTotal, configuredSlots, status,
        startsAt: input.startsAt || null, description:String(input.description || ''), thumbnailUrl:input.thumbnailUrl || null,
        featuredCardIds:Array.isArray(input.featuredCardIds) ? [...new Set(input.featuredCardIds)] : [], displayOrder:Number.isInteger(input.displayOrder) ? input.displayOrder : state.packs.length,
        slotRows:rows, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
      state.packs.push(pack); materializePackSlots(state, pack); return clone(pack);
    });
  }
  async updatePack(packId, input = {}) {
    return this.atomic(state => {
      const pack = state.packs.find(p => p.id === packId); if (!pack) throw new Error('pack not found');
      const locked = Boolean(pack.saleStartedAt) || ['selling', 'sold_out'].includes(pack.status);
      const hasConfig = input.slots !== undefined || input.slotRows !== undefined || input.totalSlots !== undefined || input.pricePoints !== undefined || input.featuredCardIds !== undefined;
      if (locked && hasConfig) throw new Error('pack configuration is immutable after sale starts');
      if (locked && Object.keys(input).some(key => !['name','description','displayOrder','reason'].includes(key))) throw new Error('only text fields can be edited after sale starts');
      if (input.name !== undefined) { const value=String(input.name).trim(); if (!value) throw new Error('invalid pack name'); pack.name=value; }
      for (const key of ['slug','description','thumbnailUrl','startsAt']) if (input[key] !== undefined) pack[key] = input[key] == null ? null : String(input[key]);
      if (input.displayOrder !== undefined) { if (!Number.isInteger(input.displayOrder) || input.displayOrder < 0) throw new Error('invalid display order'); pack.displayOrder=input.displayOrder; }
      if (input.pricePoints !== undefined) { const value=Number(input.pricePoints); if(!Number.isInteger(value)||value<1) throw new Error('invalid price'); pack.pricePoints=value; }
      if (input.featuredCardIds !== undefined) { if(!Array.isArray(input.featuredCardIds) || input.featuredCardIds.some(cardId=>!state.cards.some(c=>c.id===cardId))) throw new Error('card not found'); pack.featuredCardIds=[...new Set(input.featuredCardIds)]; }
      if (!locked && (input.slots !== undefined || input.slotRows !== undefined || input.totalSlots !== undefined)) {
        const rows=normalizeSlotRows(input.slots ?? input.slotRows ?? pack.slotRows); const total=Number(input.totalSlots ?? pack.totalSlots); const configured=rows.reduce((sum,row)=>sum+row.count,0);
        if(!rows.length||!Number.isInteger(total)||total<configured||total<1||total>100000||rows.some(row=>!state.cards.some(c=>c.id===row.cardId)||!Number.isInteger(row.count)||row.count<1||row.effectRank&&!validRank(row.effectRank))) throw new Error('invalid pack configuration');
        const needed = new Map(); for (const row of rows) needed.set(row.cardId, (needed.get(row.cardId) || 0) + row.count);
        for (const [cardId, count] of needed) if (Math.max(0, cardInventoryQuantity(state.cards.find(c => c.id === cardId)) - reservedCardCount(state, cardId, pack.id)) < count) throw new Error('insufficient pool card inventory');
        pack.slotRows=rows; pack.totalSlots=total; pack.configuredSlots=configured; state.packSlots=state.packSlots.filter(s=>s.packId!==pack.id); materializePackSlots(state,pack);
      }
      pack.updatedAt=new Date().toISOString(); return clone(pack);
    });
  }
  async updatePackStatus(packId, status, options = {}) {
    return this.atomic(state => {
      if (!PACK_STATUSES.has(status)) throw new Error('invalid pack status'); const pack=state.packs.find(p=>p.id===packId); if(!pack) throw new Error('pack not found');
      if (status === 'deleted') {
        if (pack.status === 'deleted') throw new Error('pack already deleted');
        // Keep drawn slots for audit/history; removing only undrawn slots
        // releases their reservation back to the pool automatically.
        state.packSlots = state.packSlots.filter(slot => slot.packId !== pack.id || Boolean(slot.drawnAt));
        pack.status = 'deleted'; pack.deletedAt = new Date().toISOString(); pack.updatedAt = pack.deletedAt;
        return clone(pack);
      }
      if (status === 'selling' && pack.configuredSlots !== pack.totalSlots) throw new Error('pack configuration is incomplete');
      if (pack.status === 'sold_out' && status !== 'sold_out') throw new Error('sold out pack cannot be reopened');
      if (pack.status === 'stopped' && status !== 'stopped') throw new Error('stopped pack cannot be reopened');
      if (pack.status === 'selling' && ['draft','scheduled'].includes(status)) throw new Error('selling pack cannot be unpublished');
      if (status === 'scheduled' && (!pack.startsAt || Number.isNaN(Date.parse(pack.startsAt)))) throw new Error('scheduled pack requires startsAt');
      if (status === 'selling' && pack.startsAt && Date.parse(pack.startsAt) > Date.now()) throw new Error('pack sale has not started');
      pack.status=status; if (status === 'selling') pack.saleStartedAt ||= new Date().toISOString(); pack.updatedAt=new Date().toISOString(); return clone(pack);
    });
  }
  async duplicatePack(packId, overrides = {}) {
    const source = this.state.packs.find(p=>p.id===packId); if(!source) throw new Error('pack not found');
    return this.createPack({ ...source, ...overrides, slug:overrides.slug || `${source.slug}-copy-${Date.now()}`, name:overrides.name || `${source.name} コピー`, status:'draft', slotRows:clone(source.slotRows || []), slots:undefined, id:undefined });
  }
  async createCard(card = {}) {
    return this.atomic(state => {
      const item=normalizeCard(card); if(!item) throw new Error('invalid card');
      const quantity = item.inventoryQuantity ?? 0; delete item.inventoryQuantity;
      const existing = state.cards.find(candidate => cardIdentity(candidate) === cardIdentity(item));
      if (existing) {
        existing.inventoryQuantity = cardInventoryQuantity(existing) + quantity;
        existing.updatedAt = new Date().toISOString();
        return { ...clone(existing), merged: true, addedInventoryQuantity: quantity };
      }
      item.inventoryQuantity = quantity; item.id=id('card'); item.createdAt=new Date().toISOString(); item.updatedAt=item.createdAt; state.cards.push(item); return clone(item);
    });
  }
  async updateCard(cardId, patch = {}) { return this.atomic(state => { const card=state.cards.find(c=>c.id===cardId); if(!card) throw new Error('card not found'); const next=normalizeCard({...card,...patch}, {partial:true}); if(!next) throw new Error('invalid card'); if(next.inventoryQuantity !== undefined && next.inventoryQuantity < reservedCardCount(state, cardId)) throw new Error('inventory cannot be below gacha-assigned quantity'); const identity=cardIdentity({...card,...next}); const duplicate=state.cards.find(candidate=>candidate.id!==cardId&&cardIdentity(candidate)===identity); if(duplicate) throw new Error('card identity already exists'); Object.assign(card,next,{updatedAt:new Date().toISOString()}); return clone(card); }); }
  async deleteCard(cardId) { return this.atomic(state => { const card=state.cards.find(c=>c.id===cardId); if(!card) throw new Error('card not found'); if(state.packSlots.some(s=>s.cardId===cardId)) throw new Error('card is used by a pack'); if(state.userCards.some(c=>c.cardId===cardId)) throw new Error('card has issued history'); state.cards=state.cards.filter(c=>c.id!==cardId); return clone(card); }); }
  async importCardsCsv(csv) {
    const rows=parseCsv(String(csv || '')); if(!rows.length) throw new Error('CSV is empty');
    return this.atomic(state => { const imported=[]; for(const row of rows){ const item=normalizeCard(row); if(!item) throw new Error('invalid card CSV row'); const quantity=item.inventoryQuantity ?? 0; delete item.inventoryQuantity; const existing=state.cards.find(candidate=>cardIdentity(candidate)===cardIdentity(item)); if(existing){ existing.inventoryQuantity=cardInventoryQuantity(existing)+quantity; existing.updatedAt=new Date().toISOString(); imported.push({...clone(existing),merged:true,addedInventoryQuantity:quantity}); } else { item.inventoryQuantity=quantity; item.id=id('card'); item.createdAt=new Date().toISOString(); item.updatedAt=item.createdAt; state.cards.push(item); imported.push(item); } } return imported.map(clone); });
  }
  async setEffectRank(input = {}) { return this.atomic(state => { const name=String(input.name || input.rarity || '').trim(); if(!validRank(name)) throw new Error('valid effect rank required'); const fallbackRank=input.fallbackRank ? String(input.fallbackRank) : null; if(fallbackRank && !validRank(fallbackRank)) throw new Error('invalid fallback rank'); const existing=state.effectRanks.find(x=>x.name===name); if(existing){ if(input.label!==undefined)existing.label=String(input.label); if(input.fallbackRank!==undefined)existing.fallbackRank=fallbackRank; return clone(existing); } const item={id:id('rank'),name,label:String(input.label||name),fallbackRank,createdAt:new Date().toISOString()}; state.effectRanks.push(item); return clone(item); }); }
  async setEffect(effect = {}) { return this.atomic(state => { const rarity=String(effect.rarity||'').trim(); if(!validRank(rarity)) throw new Error('valid rarity required'); if(effect.url && !isSafeMediaUrl(effect.url)) throw new Error('effect URL must use http(s) or data media'); if(effect.sizeBytes!==undefined && (!Number.isInteger(effect.sizeBytes)||effect.sizeBytes<=0||effect.sizeBytes>20*1024*1024)) throw new Error('effect video exceeds 20MB'); const mimeType=effect.mimeType || ({mp4:'video/mp4',webm:'video/webm'}[effect.format]||null); if(mimeType && !['video/mp4','video/webm'].includes(mimeType)) throw new Error('effect video must be mp4 or webm'); const existing=state.effectVideos.find(x=>x.rarity===rarity); const value={rarity,url:effect.url||null,label:String(effect.label||`${rarity} effect`),mimeType,sizeBytes:effect.sizeBytes ?? null,fallback:effect.fallback===true}; if(existing){Object.assign(existing,value);return clone(existing);} const item={id:id('effect'),...value}; state.effectVideos.push(item); return clone(item); }); }
  verifyDrawLog() { let previousHash = null; for (const entry of this.state.draws) { const { hash, previousHash: recordedPrevious, ...drawData } = entry; if (recordedPrevious !== previousHash || hash !== hashDraw(previousHash, drawData)) return false; previousHash = hash; } return true; }
  packOdds(packId) { const slots=this.state.packSlots.filter(s=>s.packId===packId); const counts={}; for(const slot of slots) counts[slot.rarity]=(counts[slot.rarity]||0)+1; const total=slots.length; return Object.fromEntries(Object.entries(counts).map(([rarity,count])=>[rarity,{count,total,probability:total?count/total:0}])); }
  packLineup(packId) { const counts=new Map(); for(const slot of this.state.packSlots.filter(s=>s.packId===packId)){ const key=`${slot.cardId}\u0000${slot.effectRank||''}`; const prior=counts.get(key); if(prior)prior.count++; else counts.set(key,{cardId:slot.cardId,effectRank:slot.effectRank||null,count:1}); } return [...counts.values()].map(item=>({ ...item, card:publicCard(this.state.cards.find(c=>c.id===item.cardId)), probability:item.count/(this.state.packs.find(p=>p.id===packId)?.totalSlots||1) })); }
  publicPacks() { return this.state.packs.slice().sort((a,b)=>(a.displayOrder??0)-(b.displayOrder??0)).map(p => ({ ...p, status:p.status === 'scheduled' && Date.parse(p.startsAt) <= Date.now() ? 'selling' : p.status, slotRows:undefined, remaining: this.state.packSlots.filter(s => s.packId === p.id && !s.drawnAt).length })); }
  // A redeemed card is no longer part of the user's holdings. Keep it in
  // admin/audit history, but omit it from the user-facing collection.
  publicCards(userId) { return this.state.userCards.filter(c => c.userId === userId && c.status !== 'redeemed').map(c => ({ ...c, card: publicCard(this.state.cards.find(x => x.id === c.cardId)) })); }
}

export const publicUser = u => ({ id: u.id, email: u.email, points: u.points, role: u.role, birthDate: u.birthDate });
export const publicCard = c => c && ({ id: c.id, name: c.name, rarity: c.rarity, imageUrl: c.imageUrl, redeemPoints: c.redeemPoints });
export const generateTotp = totp;

function seedDemo(state) {
  state.addresses = []; state.shipments = []; state.shipmentItems = []; state.effectVideos = [
    { id: 'effect_default_sr', rarity: 'SR', url: null, label: 'デフォルト金演出' },
    { id: 'effect_default_ssr', rarity: 'SSR', url: null, label: 'デフォルト虹演出' }
  ];
  const rarities = ['N', 'N', 'N', 'R', 'R', 'SR', 'SSR'];
  for (let i = 1; i <= 50; i++) state.cards.push({ id: `card_${i}`, name: `Demo Card ${String(i).padStart(2, '0')}`, rarity: rarities[i % rarities.length], imageUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="450"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="50%" fill="white" font-size="28" text-anchor="middle">Card ${i}</text></svg>`)}`, redeemPoints: 50 + i * 10 });
  const defs = [
    ['starter', 'Starter Spark', 100, 30], ['rare', 'Rare Vault', 250, 60], ['premium', 'Premium Rainbow', 1000, 100]
  ];
  for (const [slug, name, pricePoints, count] of defs) {
    const packId = `pack_${slug}`; state.packs.push({ id: packId, slug, name, pricePoints, totalSlots: count, status: 'selling', createdAt: new Date().toISOString() });
    for (let i = 0; i < count; i++) {
      const rarity = i === count - 1 ? 'SSR' : i % 25 === 0 ? 'SR' : i % 5 === 0 ? 'R' : 'N';
      const pool = state.cards.filter(c => c.rarity === rarity); const card = pool[i % pool.length];
      state.packSlots.push({ id: `${packId}_slot_${i + 1}`, packId, cardId: card.id, rarity, drawnAt: null });
    }
  }
  const admin = { id: 'usr_admin', email: 'admin@example.com', birthDate: '1980-01-01', role: 'admin', points: 0, passwordSalt: '', passwordHash: '' };
  const p = passwordHash('admin-dev-password'); admin.passwordSalt = p.salt; admin.passwordHash = p.hash; state.users.push(admin);
}
