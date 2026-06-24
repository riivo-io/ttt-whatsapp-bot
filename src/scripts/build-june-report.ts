/**
 * One-off: pull sessions / messages / whatsapp_cases (+ claude_usage) from
 * 2026-06-01 onward and emit a detailed markdown report at docs/june-report.md.
 *
 * The markdown carries both human-readable analysis and machine-readable JSON
 * data blocks (fenced as ```json data:<name>) so it can be used as the single
 * source for a dynamic HTML dashboard.
 *
 *   npx tsx src/scripts/build-june-report.ts
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Window start. Defaults to 2026-06-01; override with the first CLI arg
// (e.g. `npm run report -- 2026-07-01`) or the REPORT_SINCE env var.
const SINCE = (() => {
    const raw = process.argv[2] || process.env.REPORT_SINCE || '2026-06-01';
    // Accept a bare date (YYYY-MM-DD) or a full ISO string.
    return raw.includes('T') ? raw : `${raw}T00:00:00.000Z`;
})();

const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** Page through a table to avoid the 1000-row PostgREST default cap. */
async function fetchAll(table: string, tsColumn: string): Promise<any[]> {
    const out: any[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
            .from(table)
            .select('*')
            .gte(tsColumn, SINCE)
            .order(tsColumn, { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) {
            console.error(`[${table}] fetch error:`, error.message);
            break;
        }
        out.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    console.log(`[${table}] fetched ${out.length} rows since ${SINCE}`);
    return out;
}

function pct(n: number, d: number): string {
    if (!d) return '0%';
    return `${((n / d) * 100).toFixed(1)}%`;
}

function tally(rows: any[], key: string): Record<string, number> {
    const m: Record<string, number> = {};
    for (const r of rows) {
        const k = r[key] == null ? '(null)' : String(r[key]);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

function dayKey(iso: string | null): string {
    return iso ? iso.slice(0, 10) : '(null)';
}

function tallyByDay(rows: any[], tsColumn: string): Record<string, number> {
    const m: Record<string, number> = {};
    for (const r of rows) {
        const k = dayKey(r[tsColumn]);
        m[k] = (m[k] || 0) + 1;
    }
    return m;
}

function mdTable(headers: string[], rows: (string | number)[][]): string {
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
    return `${head}\n${sep}\n${body}`;
}

function jsonBlock(name: string, payload: any): string {
    return `\n\`\`\`json data:${name}\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

async function main() {
    const [allSessions, allMessages, cases, usage] = await Promise.all([
        fetchAll('sessions', 'created_at'),
        fetchAll('messages', 'timestamp'),
        fetchAll('whatsapp_cases', 'created_at'),
        fetchAll('claude_usage', 'created_at').catch(() => []),
    ]);

    // -------------------------------------------------------------------------
    // Campaign vs real-conversation split.
    //
    // Campaign sends arrive via /webhook/outbound-notify, which inserts an
    // assistant message with a non-null external_id (the sender_message_id) and
    // spins up a session shell that never sees a Claude turn (message_count 0).
    // Those dominate the raw counts (~88% of messages, ~97% of sessions) and
    // would drown out the actual conversational signal, so we strip them here
    // and report campaign reach separately in its own section.
    // -------------------------------------------------------------------------
    const campaignMessages = allMessages.filter(m => m.external_id != null);
    const messages = allMessages.filter(m => m.external_id == null);

    // A session is a "real conversation" if it produced a Claude turn
    // (message_count > 0) or carries an inbound user message. Everything else
    // is a campaign/outbound shell.
    const sessionsWithUserMsgId = new Set(
        messages.filter(m => m.role === 'user').map(m => m.session_id)
    );
    const sessions = allSessions.filter(s =>
        (s.message_count || 0) > 0 || sessionsWithUserMsgId.has(s.id));
    const campaignSessions = allSessions.filter(s => !sessions.includes(s));

    // ---- Sessions ----
    const sessByCrmType = tally(sessions, 'crm_type');
    const sessByStatus = tally(sessions, 'status');
    const sessByDay = tallyByDay(sessions, 'created_at');
    const sessWithDoc = sessions.filter(s => s.had_doc_upload).length;
    const sessWithEsc = sessions.filter(s => s.had_escalation).length;
    const sessCapBlocked = sessions.filter(s => s.cap_blocked_at).length;
    const totalTokens = sessions.reduce((a, s) => a + (s.token_count || 0), 0);
    const totalSessMsgs = sessions.reduce((a, s) => a + (s.message_count || 0), 0);

    // ---- Messages ----
    const msgByRole = tally(messages, 'role');
    const msgByDay = tallyByDay(messages, 'timestamp');
    const uniqueSessionsWithMsgs = new Set(messages.map(m => m.session_id)).size;
    const avgMsgLen = messages.length
        ? Math.round(messages.reduce((a, m) => a + (m.content?.length || 0), 0) / messages.length)
        : 0;

    // ---- Cases ----
    const caseByStatus = tally(cases, 'status');
    const caseByLevel = tally(cases, 'level');
    const caseByTopic = tally(cases, 'level_topic');
    const caseByFeedback = tally(cases, 'feedback_received');
    const caseByDay = tallyByDay(cases, 'created_at');
    const resolvedByBot = cases.filter(c =>
        c.status === 'resolved_by_bot' || c.status === 'resolved_by_bot_timeout').length;
    const escalated = cases.filter(c => c.status === 'escalated').length;
    const qualified = cases.filter(c => c.is_qualified).length;

    // ---- Usage / cost ----
    const totalCost = usage.reduce((a: number, u: any) => a + (Number(u.cost_usd) || 0), 0);
    const usageByPurpose = tally(usage, 'call_purpose');
    const usageByModel = tally(usage, 'model');
    const usageInputTokens = usage.reduce((a: number, u: any) => a + (u.input_tokens || 0), 0);
    const usageOutputTokens = usage.reduce((a: number, u: any) => a + (u.output_tokens || 0), 0);
    const usageCacheRead = usage.reduce((a: number, u: any) => a + (u.cache_read_tokens || 0), 0);
    const num429 = usage.filter((u: any) => u.was_429).length;

    const generatedAt = new Date().toISOString();

    const lines: string[] = [];
    const P = (s = '') => lines.push(s);

    P(`# TTT WhatsApp Bot — Activity Report`);
    P();
    P(`**Window:** 2026-06-01 → present  `);
    P(`**Generated:** ${generatedAt}  `);
    P(`**Source:** Supabase (\`sessions\`, \`messages\`, \`whatsapp_cases\`, \`claude_usage\`)`);
    P();
    P(`> This file is structured for a dynamic HTML report. Human-readable tables`);
    P(`> sit alongside machine-readable data blocks fenced as`);
    P(`> \`\`\`json data:<name>\`\`\` — parse those to drive charts/widgets.`);
    P();
    P(`> **Campaign traffic is excluded from all conversational metrics below.**`);
    P(`> Outbound campaign sends (${campaignMessages.length.toLocaleString()} messages across`);
    P(`> ${campaignSessions.length.toLocaleString()} session shells) are reported separately in §6 (Campaign reach).`);
    P(`> Sections 1–5 cover real conversations only.`);
    P();

    // -------------------------------------------------------------- Headline
    P(`## 1. Headline numbers`);
    P();
    P(mdTable(['Metric', 'Value'], [
        ['Conversations (real sessions)', sessions.length],
        ['Conversational messages', messages.length],
        ['  ↳ user', msgByRole['user'] || 0],
        ['  ↳ assistant', msgByRole['assistant'] || 0],
        ['Cases', cases.length],
        ['  ↳ resolved by bot', `${resolvedByBot} (${pct(resolvedByBot, cases.length)})`],
        ['  ↳ escalated', `${escalated} (${pct(escalated, cases.length)})`],
        ['Sessions w/ doc upload', sessWithDoc],
        ['Sessions w/ escalation', sessWithEsc],
        ['Sessions cap-blocked', sessCapBlocked],
        ['Claude API calls', usage.length],
        ['Claude cost (USD)', `$${totalCost.toFixed(2)}`],
        ['Total tokens (session counters)', totalTokens.toLocaleString()],
        ['Campaign sends (excluded above)', `${campaignMessages.length.toLocaleString()} → §6`],
    ]));
    P(jsonBlock('headline', {
        window_start: SINCE,
        generated_at: generatedAt,
        sessions: sessions.length,
        messages: messages.length,
        messages_user: msgByRole['user'] || 0,
        messages_assistant: msgByRole['assistant'] || 0,
        cases: cases.length,
        cases_resolved_by_bot: resolvedByBot,
        cases_escalated: escalated,
        cases_qualified: qualified,
        sessions_with_doc_upload: sessWithDoc,
        sessions_with_escalation: sessWithEsc,
        sessions_cap_blocked: sessCapBlocked,
        claude_calls: usage.length,
        claude_cost_usd: Number(totalCost.toFixed(4)),
        total_tokens: totalTokens,
        avg_message_length_chars: avgMsgLen,
        campaign_messages_excluded: campaignMessages.length,
        campaign_sessions_excluded: campaignSessions.length,
    }));

    // -------------------------------------------------------------- Sessions
    P(`## 2. Sessions`);
    P();
    P(`**${sessions.length}** sessions; **${uniqueSessionsWithMsgs}** had at least one logged message. `);
    P(`Avg ${sessions.length ? (totalSessMsgs / sessions.length).toFixed(1) : 0} messages/session (per session counters).`);
    P();
    P(`### By CRM type`);
    P(mdTable(['CRM type', 'Sessions'], Object.entries(sessByCrmType).map(([k, v]) => [k, v])));
    P(`### By status`);
    P(mdTable(['Status', 'Sessions'], Object.entries(sessByStatus).map(([k, v]) => [k, v])));
    P(jsonBlock('sessions_breakdown', {
        by_crm_type: sessByCrmType,
        by_status: sessByStatus,
        by_day: sessByDay,
        with_doc_upload: sessWithDoc,
        with_escalation: sessWithEsc,
        cap_blocked: sessCapBlocked,
    }));

    // -------------------------------------------------------------- Messages
    P(`## 3. Messages`);
    P();
    P(`**${messages.length}** messages logged across **${uniqueSessionsWithMsgs}** sessions. `);
    P(`Avg length **${avgMsgLen}** chars. User/assistant split: `);
    P(`${msgByRole['user'] || 0} / ${msgByRole['assistant'] || 0}.`);
    P();
    P(`### Volume by day`);
    P(mdTable(['Day', 'Messages'], Object.entries(msgByDay).map(([k, v]) => [k, v])));
    P(jsonBlock('messages_breakdown', {
        by_role: msgByRole,
        by_day: msgByDay,
        unique_sessions: uniqueSessionsWithMsgs,
        avg_length_chars: avgMsgLen,
    }));

    // -------------------------------------------------------------- Cases
    P(`## 4. WhatsApp cases`);
    P();
    P(`**${cases.length}** cases (**${qualified}** qualified). `);
    P(`Auto-resolution rate: **${pct(resolvedByBot, cases.length)}**; escalation rate: **${pct(escalated, cases.length)}**.`);
    P();
    P(`### By status`);
    P(mdTable(['Status', 'Cases'], Object.entries(caseByStatus).map(([k, v]) => [k, v])));
    P(`### By level`);
    P(mdTable(['Level', 'Cases'], Object.entries(caseByLevel).map(([k, v]) => [k, v])));
    P(`### By topic`);
    P(mdTable(['Topic', 'Cases'], Object.entries(caseByTopic).map(([k, v]) => [k, v])));
    P(`### By feedback`);
    P(mdTable(['Feedback', 'Cases'], Object.entries(caseByFeedback).map(([k, v]) => [k, v])));
    P(jsonBlock('cases_breakdown', {
        by_status: caseByStatus,
        by_level: caseByLevel,
        by_topic: caseByTopic,
        by_feedback: caseByFeedback,
        by_day: caseByDay,
        qualified,
        resolved_by_bot: resolvedByBot,
        escalated,
    }));

    // -------------------------------------------------------------- Usage
    P(`## 5. Claude usage & cost`);
    P();
    P(`**${usage.length}** API calls, **$${totalCost.toFixed(2)}** total. `);
    P(`Input ${usageInputTokens.toLocaleString()} tok / output ${usageOutputTokens.toLocaleString()} tok / cache-read ${usageCacheRead.toLocaleString()} tok. `);
    P(`429s: ${num429}.`);
    P();
    P(`### By call purpose`);
    P(mdTable(['Purpose', 'Calls'], Object.entries(usageByPurpose).map(([k, v]) => [k, v])));
    P(`### By model`);
    P(mdTable(['Model', 'Calls'], Object.entries(usageByModel).map(([k, v]) => [k, v])));
    P(jsonBlock('usage_breakdown', {
        calls: usage.length,
        cost_usd: Number(totalCost.toFixed(4)),
        input_tokens: usageInputTokens,
        output_tokens: usageOutputTokens,
        cache_read_tokens: usageCacheRead,
        by_purpose: usageByPurpose,
        by_model: usageByModel,
        count_429: num429,
    }));

    // ------------------------------------------------------- Campaign reach
    P(`## 6. Campaign reach (outbound — excluded from §1–5)`);
    P();
    P(`Outbound campaign template sends, recorded via \`/webhook/outbound-notify\`. `);
    P(`These are one-way sends (no client reply yet) and are kept out of the `);
    P(`conversational metrics above so they don't inflate engagement.`);
    P();
    const campaignByDay = tallyByDay(campaignMessages, 'timestamp');
    const campaignUniquePhones = new Set(campaignSessions.map(s => s.phone_number)).size;
    P(mdTable(['Metric', 'Value'], [
        ['Campaign sends', campaignMessages.length],
        ['Session shells created', campaignSessions.length],
        ['Unique phone numbers reached', campaignUniquePhones],
    ]));
    P(`### Sends by day`);
    P(mdTable(['Day', 'Sends'], Object.entries(campaignByDay).map(([k, v]) => [k, v])));
    P(jsonBlock('campaign_breakdown', {
        sends: campaignMessages.length,
        session_shells: campaignSessions.length,
        unique_phones: campaignUniquePhones,
        by_day: campaignByDay,
    }));

    // -------------------------------------------------------------- Raw data
    P(`## 7. Raw data (for drill-down widgets)`);
    P();
    P(`Phone numbers are included as-is from the cache. Redact before sharing externally.`);
    P(jsonBlock('raw_cases', cases.map(c => ({
        id: c.id,
        created_at: c.created_at,
        phone_number: c.phone_number,
        status: c.status,
        level: c.level,
        level_topic: c.level_topic,
        is_qualified: c.is_qualified,
        resolution_method: c.resolution_method,
        feedback_received: c.feedback_received,
        query_text: c.query_text,
    }))));
    // `sessions` is already the real-conversation subset (campaign shells were
    // stripped at the top), so we dump it whole — it's the engaged set.
    P(`Real conversations (campaign shells excluded): **${sessions.length}**.`);
    P(jsonBlock('raw_sessions', sessions.map(s => ({
        id: s.id,
        created_at: s.created_at,
        last_active: s.last_active,
        phone_number: s.phone_number,
        crm_type: s.crm_type,
        status: s.status,
        message_count: s.message_count,
        token_count: s.token_count,
        had_doc_upload: s.had_doc_upload,
        had_escalation: s.had_escalation,
    }))));

    // Output path: REPORT_OUT env wins; otherwise derive from the window start
    // (docs/whatsapp-report-YYYY-MM.md), preserving the original june-report.md
    // when run with the default June window.
    const outName = process.env.REPORT_OUT
        || (SINCE.startsWith('2026-06') ? 'june-report.md' : `whatsapp-report-${SINCE.slice(0, 7)}.md`);
    const outPath = path.isAbsolute(outName) ? outName : path.join(process.cwd(), 'docs', outName);
    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`\nWrote ${outPath} (${lines.length} lines)`);
}

main().catch(err => { console.error(err); process.exit(1); });
