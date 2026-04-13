import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SESSION_TIMEOUT_MINUTES = 30;

interface Session {
    id: string;
    phone_number: string;
    crm_id: string | null;
    crm_type: string;
    status: string;
    current_intent: string | null;
    current_step: string | null;
    last_active: string;
    created_at: string;
    role_id: string | null;
    permitted_tools: string[];
}

export interface StaffRecord {
    id: string;
    full_name: string;
    mobile_number: string | null;
    role_id: string | null;
    dynamics_user_id: string;
}

interface Message {
    id: string;
    session_id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

class SupabaseService {
    private client: SupabaseClient;

    constructor() {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
        }

        this.client = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );
    }

    /**
     * Look up a phone number in previous sessions to find cached CRM info.
     * Returns the most recent session with a known crm_id, or null.
     */
    async findPreviousSession(phoneNumber: string): Promise<{ id: string; crm_id: string; crm_type: string } | null> {
        const { data, error } = await this.client
            .from('sessions')
            .select('id, crm_id, crm_type')
            .eq('phone_number', phoneNumber)
            .not('crm_id', 'is', null)
            .order('last_active', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) {
            return null;
        }

        console.log(`[Supabase] Found previous session for ${phoneNumber}: ${data.crm_type} (${data.crm_id})`);
        return { id: data.id, crm_id: data.crm_id, crm_type: data.crm_type };
    }

    async expireSession(sessionId: string): Promise<void> {
        await this.client
            .from('sessions')
            .update({ status: 'expired' })
            .eq('id', sessionId);
    }

    /**
     * Find or create a session for this phone number.
     * If an active session exists within the timeout window, resume it.
     * Otherwise, expire the old one and create a new session.
     */
    async getOrCreateSession(
        phoneNumber: string,
        crmId: string | null,
        crmType: string,
        roleId: string | null = null,
        permittedTools: string[] = []
    ): Promise<Session> {
        // Look for an active session for this phone number
        const { data: existing, error: fetchError } = await this.client
            .from('sessions')
            .select('*')
            .eq('phone_number', phoneNumber)
            .eq('status', 'active')
            .order('last_active', { ascending: false })
            .limit(1)
            .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
            // PGRST116 = no rows found — that's fine, everything else is a real error
            console.error('[Supabase] Session lookup error:', fetchError.message);
        }

        if (existing) {
            // Check if session has timed out
            const lastActive = new Date(existing.last_active).getTime();
            const now = Date.now();
            const minutesSinceActive = (now - lastActive) / 1000 / 60;

            if (minutesSinceActive < SESSION_TIMEOUT_MINUTES) {
                // Session still active — touch last_active. Also backfill
                // role_id / permitted_tools if this is a staff user and the
                // existing session was created before the role was assigned
                // (or before these columns existed).
                const updates: Record<string, any> = { last_active: new Date().toISOString() };
                if (roleId && !existing.role_id) updates.role_id = roleId;
                if (permittedTools.length > 0 && (!existing.permitted_tools || existing.permitted_tools.length === 0)) {
                    updates.permitted_tools = permittedTools;
                }

                await this.client
                    .from('sessions')
                    .update(updates)
                    .eq('id', existing.id);

                console.log(`[Supabase] Resumed session ${existing.id} for ${phoneNumber}${updates.role_id ? ' (backfilled role)' : ''}`);
                return { ...existing, ...updates } as Session;
            }

            // Session expired — mark it
            await this.client
                .from('sessions')
                .update({ status: 'expired' })
                .eq('id', existing.id);

            console.log(`[Supabase] Expired session ${existing.id} (inactive ${Math.round(minutesSinceActive)}m)`);
        }

        // Create a new session
        const { data: newSession, error: createError } = await this.client
            .from('sessions')
            .insert({
                phone_number: phoneNumber,
                crm_id: crmId,
                crm_type: crmType,
                status: 'active',
                role_id: roleId,
                permitted_tools: permittedTools,
            })
            .select()
            .single();

        if (createError || !newSession) {
            throw new Error(`[Supabase] Failed to create session: ${createError?.message}`);
        }

        console.log(`[Supabase] Created new session ${newSession.id} for ${phoneNumber} (${crmType})`);
        return newSession as Session;
    }

    /**
     * Save a message to the messages table.
     */
    async saveMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
        const { error } = await this.client
            .from('messages')
            .insert({
                session_id: sessionId,
                role,
                content,
            });

        if (error) {
            console.error(`[Supabase] Failed to save ${role} message:`, error.message);
        }
    }

    /**
     * Get conversation history for a session, ordered oldest-first for OpenAI context.
     */
    async getHistory(sessionId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
        const { data, error } = await this.client
            .from('messages')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: true });

        if (error) {
            console.error('[Supabase] Failed to fetch history:', error.message);
            return [];
        }

        return (data || []) as { role: 'user' | 'assistant'; content: string }[];
    }

    /**
     * Log every CRM write for audit purposes.
     */
    async logCrmWrite(params: {
        crmEntity: string;
        crmRecordId?: string;
        action: 'create' | 'update';
        payload: Record<string, any>;
        triggeredBy: string;
    }): Promise<void> {
        const { error } = await this.client
            .from('crm_audit_log')
            .insert({
                crm_entity: params.crmEntity,
                crm_record_id: params.crmRecordId || null,
                action: params.action,
                payload: params.payload,
                ai_triggered_by: params.triggeredBy,
                ai_model: 'gpt-4o-mini',
                ai_generated_at: new Date().toISOString(),
            });

        if (error) {
            console.error('[Supabase] Failed to log CRM audit:', error.message);
        }
    }

    /**
     * Look up an internal staff member by their WhatsApp mobile number.
     * Matches against the users table (synced from Dynamics systemuser).
     * Tries the number as-given, then with common SA phone prefix variations
     * (+27 / 0 / 27) so that however it arrives from WhatsApp, we still match.
     * Returns null if no staff match.
     */
    async findStaffByPhone(phoneNumber: string): Promise<StaffRecord | null> {
        const variants = this.phoneVariants(phoneNumber);

        const { data, error } = await this.client
            .from('users')
            .select('id, full_name, mobile_number, role_id, dynamics_user_id')
            .in('mobile_number', variants)
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('[Supabase] findStaffByPhone error:', error.message);
            return null;
        }
        return (data as StaffRecord) || null;
    }

    /**
     * Load the list of tool permission names that are enabled for a given role.
     * Used to cache permitted_tools on the session at creation time.
     */
    async getPermittedTools(roleId: string): Promise<string[]> {
        const { data, error } = await this.client
            .from('role_tools')
            .select('tool_name')
            .eq('role_id', roleId)
            .eq('enabled', true);

        if (error) {
            console.error('[Supabase] getPermittedTools error:', error.message);
            return [];
        }
        return (data || []).map((r: any) => r.tool_name);
    }

    /**
     * Look up a role by its name (e.g. "Full Access", "Some Access", "No Access").
     * Used by the test-mode context switcher to impersonate different roles.
     */
    async getRoleByName(name: string): Promise<{ id: string; name: string } | null> {
        const { data, error } = await this.client
            .from('roles')
            .select('id, name')
            .eq('name', name)
            .maybeSingle();

        if (error) {
            console.error('[Supabase] getRoleByName error:', error.message);
            return null;
        }
        return data;
    }

    /**
     * Produce common SA phone-number variants for fuzzy lookup.
     * e.g. given "0832852913" returns ["0832852913", "+27832852913", "27832852913"].
     */
    private phoneVariants(phone: string): string[] {
        const trimmed = phone.trim().replace(/\s+/g, '');
        const variants = new Set<string>([trimmed]);

        if (trimmed.startsWith('0') && trimmed.length === 10) {
            variants.add('+27' + trimmed.slice(1));
            variants.add('27' + trimmed.slice(1));
        } else if (trimmed.startsWith('+27') && trimmed.length === 12) {
            variants.add('0' + trimmed.slice(3));
            variants.add('27' + trimmed.slice(1));
        } else if (trimmed.startsWith('27') && trimmed.length === 11) {
            variants.add('0' + trimmed.slice(2));
            variants.add('+' + trimmed);
        }
        return Array.from(variants);
    }

    /**
     * Update session flow state (intent + step) for multi-step flows.
     */
    async updateSessionState(
        sessionId: string,
        intent: string | null,
        step: string | null
    ): Promise<void> {
        const { error } = await this.client
            .from('sessions')
            .update({
                current_intent: intent,
                current_step: step,
                last_active: new Date().toISOString(),
            })
            .eq('id', sessionId);

        if (error) {
            console.error('[Supabase] Failed to update session state:', error.message);
        }
    }
}

export const supabaseService = new SupabaseService();
