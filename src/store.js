import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_FILE = process.env.GACHA_DATA_FILE || path.join(process.cwd(), 'data', 'store.json');
const clone = value => JSON.parse(JSON.stringify(value));
const id = prefix => `${prefix}_${crypto.randomBytes(10).toString('hex')}`;

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function passwordMatches(password, user) {
  const actual = passwordHash(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function emptyState() {
  return { users: [], sessions: [], cards: [], packs: [], packSlots: [], draws: [], userCards: [], pointTransactions: [] };
}
function ageAtLeast18(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const birth = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  if (birth.toISOString().slice(0, 10) !== date) return false;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age >= 18;
}

function hashDraw(previousHash, draw) {
  return crypto.createHash('sha256').update(JSON.stringify({ previousHash, ...draw })).digest('hex');
}

export class Store {
  constructor(file = DATA_FILE) {
    this.file = file;
    this.state = this.load();
    for (const key of ['addresses', 'shipments', 'shipmentItems', 'effectVideos']) this.state[key] ||= [];
    this.lock = Promise.resolve();
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
  register({ email, password, birthDate, ageConfirmed }) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < 8 || !birthDate || !ageConfirmed || !ageAtLeast18(birthDate)) {
      throw new Error('email, password (8+ chars), valid birthDate and age confirmation are required');
    }
    email = email.trim().toLowerCase();
    if (this.state.users.some(u => u.email === email)) throw new Error('email already registered');
    const userId = id('usr'); const p = passwordHash(password);
    this.state.users.push({ id: userId, email, birthDate, passwordSalt: p.salt, passwordHash: p.hash, points: 0, role: 'user', createdAt: new Date().toISOString() });
    this.persist();
    return this.state.users.at(-1);
  }
  login(email, password) {
    const user = this.state.users.find(u => u.email === String(email).trim().toLowerCase());
    if (!user || !passwordMatches(password, user)) throw new Error('invalid credentials');
    const token = crypto.randomBytes(32).toString('base64url');
    this.state.sessions = this.state.sessions.filter(s => s.userId !== user.id);
    this.state.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    this.persist();
    return { token, user: publicUser(user) };
  }
  userForToken(token) {
    const session = this.state.sessions.find(s => s.token === token);
    if (session && session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) { this.state.sessions = this.state.sessions.filter(s => s !== session); this.persist(); return null; }
    return session && this.state.users.find(u => u.id === session.userId);
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
  async draw(userId, packId, quantity = 1) {
    return this.atomic(state => {
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity must be a positive integer');
      const user = state.users.find(u => u.id === userId); const pack = state.packs.find(p => p.id === packId);
      if (!user || !pack) throw new Error('user or pack not found');
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
        const previousHash = state.draws.at(-1)?.hash || null;
        const drawData = { id: id('drw'), userId, packId, slotId: slot.id, cardId: card.id, rarity: card.rarity, remainingBefore, remainingAfter: remainingBefore - 1, createdAt: slot.drawnAt };
        const draw = { ...drawData, previousHash, hash: hashDraw(previousHash, drawData) };
        state.draws.push(draw);
        const userCard = { id: id('uc'), userId, cardId: card.id, drawId: draw.id, status: 'unprocessed', obtainedAt: slot.drawnAt };
        state.userCards.push(userCard);
        const effect = state.effectVideos?.find(e => e.rarity === card.rarity) || null;
        results.push({ draw, card: publicCard(card), userCard, effect: effect ? { rarity: effect.rarity, url: effect.url, label: effect.label } : { rarity: card.rarity, url: null, label: 'default animation' } });
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
  async createPack({ slug, name, pricePoints, slots }) { return this.atomic(state => { if (!slug || !name || !Number.isInteger(pricePoints) || pricePoints < 1 || !Array.isArray(slots) || !slots.length) throw new Error('invalid pack'); const idValue=id('pack'); const pack={id:idValue,slug,name,pricePoints,totalSlots:slots.length,status:'selling',createdAt:new Date().toISOString()}; state.packs.push(pack); slots.forEach((cardId, index) => { if(!state.cards.some(c=>c.id===cardId)) throw new Error('card not found'); state.packSlots.push({id:`${idValue}_slot_${index+1}`,packId:idValue,cardId,rarity:state.cards.find(c=>c.id===cardId).rarity,drawnAt:null}); }); return pack; }); }
  async createCard(card) { return this.atomic(state => { const redeemPoints=Number(card.redeemPoints); if(!card.name || !['N','R','SR','SSR'].includes(card.rarity) || !Number.isInteger(redeemPoints) || redeemPoints < 0) throw new Error('invalid card'); const item={id:id('card'),name:String(card.name).trim(),rarity:card.rarity,imageUrl:card.imageUrl || null,redeemPoints}; state.cards.push(item); return item; }); }
  async setEffect(effect) { return this.atomic(state => { if(!['N','R','SR','SSR'].includes(effect.rarity)) throw new Error('valid rarity required'); if (effect.url && !/^https?:\/\//.test(effect.url)) throw new Error('effect URL must use http or https'); const existing=state.effectVideos.find(x=>x.rarity===effect.rarity); if(existing) { existing.url=effect.url || null; existing.label=effect.label || existing.label; return existing; } const item={id:id('effect'),rarity:effect.rarity,url:effect.url || null,label:effect.label || `${effect.rarity} effect`}; state.effectVideos.push(item); return item; }); }
  verifyDrawLog() { let previousHash = null; for (const entry of this.state.draws) { const { hash, previousHash: recordedPrevious, ...drawData } = entry; if (recordedPrevious !== previousHash || hash !== hashDraw(previousHash, drawData)) return false; previousHash = hash; } return true; }
  publicPacks() { return this.state.packs.map(p => ({ ...p, remaining: this.state.packSlots.filter(s => s.packId === p.id && !s.drawnAt).length })); }
  publicCards(userId) { return this.state.userCards.filter(c => c.userId === userId).map(c => ({ ...c, card: publicCard(this.state.cards.find(x => x.id === c.cardId)) })); }
}

export const publicUser = u => ({ id: u.id, email: u.email, points: u.points, role: u.role, birthDate: u.birthDate });
export const publicCard = c => c && ({ id: c.id, name: c.name, rarity: c.rarity, imageUrl: c.imageUrl, redeemPoints: c.redeemPoints });

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
