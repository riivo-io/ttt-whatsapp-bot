/**
 * TTTFG-5340 AC 5: the WhatsApp sign-up form updates the lead already on the number (the one Tina made for an unknown number)
 * instead of making a second one (src/domain/signUpLead.ts). Dynamics is faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveSignUpLead, signUpLeadChanges, type SignUpFormLead, type SignUpLeadChanges, type SignUpLeadPorts } from '../../src/domain/signUpLead';

const PHONE = '27839990000';
const FORM: SignUpFormLead = { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', notes: 'Wants her refund checked', clientType: 0, leadType: 100000000 };

function world(o: { existing?: { id: string; notes: string | null } | null; updateFails?: boolean; createFails?: boolean; lookupThrows?: boolean } = {}) {
    const updates: { id: string; changes: SignUpLeadChanges }[] = [];
    const creates: number[] = [];
    const ports: SignUpLeadPorts = {
        async findByPhone() {
            if (o.lookupThrows) throw new Error('Dataverse GET new_leads 429');
            return o.existing ?? null;
        },
        async update(id, changes) {
            if (o.updateFails) return false;
            updates.push({ id, changes });
            return true;
        },
        async create() {
            if (o.createFails) return null;
            creates.push(1);
            return 'lead-new';
        },
    };
    return { ports, updates, creates };
}

test('AC 5: a lead already on the number (Tina\'s placeholder) is updated with what the form typed, and no second lead is made', async () => {
    const w = world({ existing: { id: 'lead-1', notes: null } });
    const saved = await saveSignUpLead(w.ports, PHONE, FORM);
    assert.deepEqual(saved, { leadId: 'lead-1', how: 'updated' });
    assert.equal(w.creates.length, 0, 'one lead remains');
    assert.deepEqual(w.updates, [{ id: 'lead-1', changes: {
        firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com', notes: 'Wants her refund checked', clientType: 0, leadType: 100000000,
    } }]);
});

test('AC 5: a number with no lead gets one, as before', async () => {
    const w = world();
    assert.deepEqual(await saveSignUpLead(w.ports, PHONE, FORM), { leadId: 'lead-new', how: 'created' });
    assert.equal(w.updates.length, 0);
    assert.equal(w.creates.length, 1);
});

test('the form\'s notes are added to the notes already on the lead, never replace them', () => {
    assert.equal(signUpLeadChanges(FORM, 'Called us on 12 Nov').notes, 'Called us on 12 Nov\nWants her refund checked');
    assert.equal(signUpLeadChanges(FORM, null).notes, 'Wants her refund checked');
    assert.equal(signUpLeadChanges({ ...FORM, notes: '  ' }, 'Called us on 12 Nov').notes, 'Called us on 12 Nov');
    assert.equal('notes' in signUpLeadChanges({ ...FORM, notes: undefined }, null), false, 'nothing to say: the column is left alone');
});

test('a worker retry does not add the form\'s notes a second time', () => {
    const once = signUpLeadChanges(FORM, 'Called us on 12 Nov').notes!;
    assert.equal(signUpLeadChanges(FORM, once).notes, once);
});

test('a type the form did not give is left as it is on the lead', () => {
    const changes = signUpLeadChanges({ firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' }, null);
    assert.deepEqual(changes, { firstName: 'Jane', lastName: 'Smith', email: 'jane@example.com' });
});

test('a CRM that refuses the update is a failed save (the person is told), not a second lead', async () => {
    const w = world({ existing: { id: 'lead-1', notes: null }, updateFails: true });
    assert.equal(await saveSignUpLead(w.ports, PHONE, FORM), null);
    assert.equal(w.creates.length, 0);
});

test('a CRM that refuses a new lead is a failed save', async () => {
    assert.equal(await saveSignUpLead(world({ createFails: true }).ports, PHONE, FORM), null);
});

test('a lookup that errors throws: it is never read as "no lead", so no second lead is made', async () => {
    const w = world({ lookupThrows: true });
    await assert.rejects(saveSignUpLead(w.ports, PHONE, FORM), /429/);
    assert.equal(w.creates.length, 0);
    assert.equal(w.updates.length, 0);
});
