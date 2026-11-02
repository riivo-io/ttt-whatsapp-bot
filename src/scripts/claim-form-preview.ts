/**
 * TTTFG-5562: the guided claim form on localhost, with every go-live form and a made-up claim held in memory. Nothing
 * touches the CRM, SharePoint or WhatsApp, so it's safe to click through on a phone-sized window.
 *
 *   npx tsx src/scripts/claim-form-preview.ts [--port 3456] [--configs ../ttt-preseason-agent/config/claimforms]
 *
 * It prints one link per form. A voice recording comes back as a sample sentence; Submit prints what Tina would do next.
 * GET /__claim/<form name> shows what the form has saved so far, for the checks in the test walkthrough.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createGuidedLink, memoryLinkStore, type GuidedLinkDeps, type GuidedLinkRow } from '../claimform/links';
import { expandRows } from '../departments/insurance/claimform';
import type { ClaimForm } from '../departments/insurance/contracts';
import type { FollowOnClaim, FollowOnPorts, StoredClaimForm } from '../departments/insurance/followon';
import { fileGuided, finishGuided, guidedView, saveGuided, type GuidedPorts } from '../departments/insurance/guided';
import { claimFormRouter, type ClaimFormSession } from '../routes/claimForm.route';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', '3456'));
const DIR = arg('configs', '../ttt-preseason-agent/config/claimforms');

const CRM = {
    contact: { fullname: 'Sipho Ndlovu', firstname: 'Sipho', lastname: 'Ndlovu', mobilephone: '082 413 7720', telephone1: '021 975 3310', emailaddress1: 'sipho@example.co.za', ttt_idnumber: '8406115123087' },
    riivo_policy: { riivo_policy_no: 'DI-7730 4415', riivo_broker: 'TTT Financial Group' },
};
const EARLIER = [{
    vehicleMake: { value: 'Toyota', status: 'answered' as const, at: '2026-03-01T08:00:00Z' },
    vehicleModel: { value: 'Hilux 2.4 GD-6 Raider', status: 'answered' as const, at: '2026-03-01T08:00:00Z' },
    vehicleRegistration: { value: 'CY 482-113', status: 'answered' as const, at: '2026-03-01T08:00:00Z' },
}];

const rows: Array<{ name: string; form: StoredClaimForm }> = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'crm-columns.json').flatMap((f) =>
    expandRows(JSON.parse(readFileSync(join(DIR, f), 'utf8'))).map((r: ClaimForm) => {
        const name = `${f.replace('.json', '')}${r.claimType ? `--${r.claimType.toLowerCase().replace(/\s+/g, '-')}` : ''}`;
        return { name, form: { ...r, id: name } };
    }));

const claims = new Map<string, FollowOnClaim>();
const done: string[] = [];

function claimFor(row: { name: string; form: StoredClaimForm }, i: number): FollowOnClaim {
    const claimType = (row.form.claimType ?? 'Other') as FollowOnClaim['claimType'];
    return {
        id: row.name, reference: `CLM-${String(24117 + i).padStart(6, '0')}`, contactId: 'preview', providerId: row.form.provider ?? '', insurer: row.form.provider ?? 'Your insurer', claimType,
        facts: { claimType, description: 'Traffic slowed down and a white VW Polo drove into the back of the bakkie.', incidentAt: '2026-11-02T07:40:00+02:00', place: 'N1 at the Durbanville off-ramp', thirdParties: true, saps: false, injuries: false } as FollowOnClaim['facts'],
        sapsRequired: ['Motor accident', 'Motor theft', 'Hijacking'].includes(claimType), status: 'FNOL logged', signatureStatus: 'Not sent', claimFormId: row.form.id, answers: {}, evidence: [],
        owner: { kind: 'user', id: 'u', name: 'Preview' }, contactAddress: '12 Oak Avenue\nDurbanville\n7550',
    };
}

const keep = (to: { claimId: string; itemKey?: string }) => {
    const c = claims.get(to.claimId)!;
    if (to.itemKey) c.evidence = [...c.evidence, { key: to.itemKey }];
};

const ports = (form: StoredClaimForm): GuidedPorts => ({
    loadClaim: async (id: string) => structuredClone(claims.get(id)!),
    claimForm: async () => form,
    saveAnswers: async (id: string, answers) => { claims.get(id)!.answers = answers; },
    saveSaps: async (id: string, v) => {
        const c = claims.get(id)!;
        if (v.caseNumber) c.sapsCaseNumber = v.caseNumber;
        if (v.station) c.sapsStation = v.station;
    },
    fileToPipeline: async (file, to) => {
        console.log(`  filed ${file.fileName} (${file.mimeType}) as ${to.itemKey ?? 'other'}`);
        keep(to);
        return { documentId: 'preview' };
    },
    storeVideo: async (file, to) => {
        console.log(`  stored video ${file.fileName} as ${to.itemKey ?? 'other'}`);
        keep(to);
        return { documentId: 'preview' };
    },
} as Partial<FollowOnPorts> as GuidedPorts);

function session(link: GuidedLinkRow): ClaimFormSession {
    const form = rows.find((r) => r.name === link.claim_id)!.form;
    const p = ports(form);
    return {
        view: async () => guidedView(form, structuredClone(claims.get(link.claim_id)!), CRM, EARLIER, 'Sipho'),
        save: (input) => saveGuided(p, link.claim_id, input, new Date()),
        file: (file, _bytes, itemKey) => fileGuided(p, link.claim_id, { ...file, id: `upload:${Date.now()}` }, itemKey, new Date()),
        hear: async () => ({ text: 'I was driving to a job and a white Polo drove into the back of the bakkie.' }),
        finish: () => finishGuided(p, link.claim_id, new Date()),
        carryOn: async () => {
            done.push(link.claim_id);
            console.log(`  ${link.claim_id}: submitted. Tina would now ask on WhatsApp for anything still missing, fill the form and send the signing link.`);
        },
    };
}

async function main() {
    const d: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: `http://localhost:${PORT}` };
    const app = express();
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session, whatsApp: '27000000000' })));
    app.get('/__claim/:name', (req, res) => res.json({ claim: claims.get(req.params.name), submitted: done.includes(req.params.name) }));
    app.listen(PORT, async () => {
        const links: Record<string, string> = {};
        for (const [i, row] of rows.entries()) {
            claims.set(row.name, claimFor(row, i));
            links[row.name] = (await createGuidedLink(d, { claimId: row.name, phone: '27000000000', contactId: 'preview' })).url;
        }
        console.log(JSON.stringify(links, null, 1));
        console.log(`Preview on http://localhost:${PORT}, ${rows.length} forms. Nothing here touches the CRM or WhatsApp.`);
    });
}

void main();
