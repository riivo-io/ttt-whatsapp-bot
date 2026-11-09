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
import { createGuidedLink, formSignatureFor, memoryLinkStore, type GuidedLinkDeps, type GuidedLinkRow } from '../claimform/links';
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
        facts: { claimType },
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
    saveFacts: async (id: string, v) => { claims.get(id)!.facts = { ...claims.get(id)!.facts, ...v }; },
    setSapsRequired: async () => undefined,
    createAgentAction: async () => ({ id: 'preview' }),
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
        view: async () => guidedView(form, structuredClone(claims.get(link.claim_id)!), CRM, EARLIER),
        save: (input) => saveGuided(p, link.claim_id, input, new Date()),
        file: (file, _bytes, itemKey) => fileGuided(p, link.claim_id, { ...file, id: `upload:${Date.now()}` }, itemKey, new Date()),
        hear: async () => ({ text: 'I was driving to a job and a white Polo drove into the back of the bakkie.' }),
        finish: () => finishGuided(p, link.claim_id, new Date()),
        carryOn: async () => {
            done.push(link.claim_id);
            const signed = await formSignatureFor(D, link.claim_id);
            console.log(signed
                ? `  ${link.claim_id}: submitted and signed on the form (signature ${signed.signature.length} characters). Tina would now fill the form and sign it with this signature: no signing link.`
                : `  ${link.claim_id}: submitted. Tina would now ask on WhatsApp for anything still missing, fill the form and send the signing link.`);
        },
    };
}

const D: GuidedLinkDeps = { store: memoryLinkStore(), publicUrl: `http://localhost:${PORT}` };

async function main() {
    const d = D;
    const app = express();
    // The user (9 Nov 2026): signing on the form, as when the signing page is set up. --no-sign shows the old Submit.
    const signOnForm = !process.argv.includes('--no-sign');
    app.use('/claim-form', claimFormRouter(() => ({ ...d, session, whatsApp: '27000000000', signOnForm })));
    app.get('/__claim/:name', async (req, res) => res.json({
        claim: claims.get(req.params.name), submitted: done.includes(req.params.name), signedOnForm: !!(await formSignatureFor(d, req.params.name)),
    }));
    const links: Record<string, string> = {};
    // A list of every form, so the preview opens on something to click.
    app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Guided form preview</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:520px;padding:20px 16px;color:#0B0F14}h1{font-size:20px;margin:0 0 4px}p{color:#6B7684;margin:0 0 16px}a{display:block;padding:12px 14px;margin:0 0 8px;border:1px solid #CDD2D8;border-radius:10px;color:#015A8E;text-decoration:none}</style>
<h1>Guided claim form preview</h1><p>Made-up claims in memory. Nothing here touches the CRM or WhatsApp.</p>${Object.entries(links).map(([name, url]) => `<a href="${url}">${name.replace('--', ' · ').replace(/-/g, ' ')}</a>`).join('')}`));
    app.listen(PORT, async () => {
        for (const [i, row] of rows.entries()) {
            claims.set(row.name, claimFor(row, i));
            links[row.name] = (await createGuidedLink(d, { claimId: row.name, phone: '27000000000', contactId: 'preview' })).url;
        }
        console.log(JSON.stringify(links, null, 1));
        console.log(`Preview on http://localhost:${PORT}, ${rows.length} forms. Nothing here touches the CRM or WhatsApp.`);
    });
}

void main();
