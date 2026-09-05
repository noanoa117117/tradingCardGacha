import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-user-detail-'));
  const store = new Store(path.join(dir, 'store.json'));
  const user = store.register({ email: 'detail@example.com', password: 'password123', birthDate: '1990-01-01', ageConfirmed: true });
  store.addPoints(user.id, 100000);
  return { store, user };
}

test('admin user detail aggregates owned activity, paginates, and strips address data', async () => {
  const { store, user } = setup();
  store.setPaymentProvider({ createPayment: async () => ({ id: 'provider-payment-1234', status: 'succeeded' }) });
  await store.createPayment({ userId: user.id, points: 1000, amount: 1000 });
  const draw = await store.draw(user.id, store.state.packs[0].id, 2);
  const address = await store.addAddress(user.id, { name: 'Private Name', postalCode: '100-0001', prefecture: 'Tokyo', city: 'Chiyoda', line1: '1-1' });
  const shipment = await store.createShipment(user.id, [draw.results[0].userCard.id], address.id);
  store.state.shipments.find(item => item.id === shipment.id).trackingNumber = 'JP-1234567890';
  for (let i = 0; i < 101; i++) store.state.pointTransactions.push({ id: `extra-${i}`, userId: user.id, amount: 1, balanceBefore: i, balanceAfter: i + 1, type: 'test', metadata: { secret: 'do-not-return' }, createdAt: new Date(1700000000000 + i).toISOString() });

  const detail = store.adminUserDetail(user.id, { role: 'owner', pageSize: 50, pointsPage: 2 });
  assert.equal(detail.user.email, user.email);
  assert.equal(detail.summary.gross, 1000);
  assert.equal(detail.summary.drawCount, 2);
  assert.equal(detail.draws.items[0].quantity, 2);
  assert.equal(detail.draws.items[0].cards.length, 2);
  assert.equal(detail.userCards.items[0].packName, 'Starter Spark');
  assert.equal(detail.shipments.items[0].address, undefined);
  assert.equal(detail.pointTransactions.page, 2);
  assert.equal(detail.pointTransactions.totalPages, 3);

  const operatorDetail = store.adminUserDetail(user.id, { role: 'operator' });
  assert.equal('id' in operatorDetail.shipments.items[0], false);
  assert.equal('userCardId' in operatorDetail.shipments.items[0].cards[0], false);
  assert.match(operatorDetail.shipments.items[0].trackingNumber, /•/);
});

test('operator and viewer user detail DTOs mask PII and do not leak internal identifiers', async () => {
  const { store, user } = setup();
  store.setPaymentProvider({ createPayment: async () => ({ id: 'provider-payment-1234', status: 'succeeded' }) });
  const payment = await store.createPayment({ userId: user.id, points: 1000, amount: 1000 });
  const operator = store.adminUserDetail(user.id, { role: 'operator' });
  assert.match(operator.user.email, /\*\*\*@/);
  assert.equal(operator.user.phone, '');
  assert.match(operator.payments.payments[0].providerPaymentId || '', /•/);
  const viewer = store.adminUserDetail(user.id, { role: 'viewer' });
  assert.match(viewer.user.email, /\*\*\*@/);
  assert.equal('id' in viewer.payments.payments[0], false);
  assert.equal('provider' in viewer.payments.payments[0], false);
  assert.equal('metadata' in viewer.payments.payments[0], false);
  assert.equal('id' in viewer.pointTransactions.items[0], false);
  assert.equal('metadata' in viewer.pointTransactions.items[0], false);
  assert.equal('userId' in viewer.payments.filters, false);
  assert.equal('userId' in (viewer.payments.users[0] || {}), false);
  assert.equal('id' in (viewer.payments.payments[0] || {}), false);
  assert.throws(() => store.adminUserDetail(store.state.adminUsers[0].userId, { role: 'owner' }), /user not found/);
});

test('admin user list DTO is allowlisted and mixed modern/legacy draws are retained', async () => {
  const { store, user } = setup();
  const modern = await store.draw(user.id, store.state.packs[0].id, 1);
  // Simulate a legacy draw written before point-transaction metadata existed.
  const legacy = { ...store.state.draws[0], id: 'legacy-draw', slotId: 'legacy-slot', createdAt: new Date(Date.now() + 1000).toISOString() };
  store.state.draws.push(legacy);
  const owner = store.adminUserListDto(user, 'owner');
  const viewer = store.adminUserListDto(user, 'viewer');
  assert.deepEqual(Object.keys(owner).sort(), ['createdAt', 'email', 'id', 'phone', 'points', 'status']);
  assert.equal('passwordHash' in owner, false);
  assert.equal('birthDate' in owner, false);
  assert.match(viewer.email, /\*\*\*@/);
  const detail = store.adminUserDetail(user.id, { role: 'owner', page: 99, drawsPage: 99 });
  assert.equal(detail.draws.page, detail.draws.totalPages);
  assert.ok(detail.draws.items.some(item => item.id === 'legacy-draw'));
  assert.ok(detail.draws.items.some(item => item.id === modern.results[0].draw.id || item.cards.some(card => card.drawId === modern.results[0].draw.id)));
});
