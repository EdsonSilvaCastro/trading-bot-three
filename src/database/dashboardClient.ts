// ============================================================
// Dashboard Client — connects to the FVG/On-Chain Supabase project
// Used for: bot_heartbeats, bot_commands, bot_logs
// The ICT bot's own Supabase project only holds trade data.
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let dashboardInstance: SupabaseClient | null = null;

function getDashboardClient(): SupabaseClient | null {
  if (dashboardInstance) return dashboardInstance;

  const url = process.env['DASHBOARD_SUPABASE_URL'];
  const key = process.env['DASHBOARD_SUPABASE_ANON_KEY'];

  if (!url || !key) return null;

  dashboardInstance = createClient(url, key, {
    auth: { persistSession: false },
  });

  return dashboardInstance;
}

// --------------- State ---------------

let paused = false;

export function isPaused(): boolean {
  return paused;
}

// --------------- Heartbeat ---------------

export async function sendHeartbeat(cycleDurationMs: number, activePositions: number): Promise<void> {
  const client = getDashboardClient();
  if (!client) return;

  try {
    await client.from('bot_heartbeats').insert({
      bot_name: 'ict',
      status: paused ? 'PAUSED' : 'OK',
      cycle_duration_ms: cycleDurationMs,
      active_positions: activePositions,
    });
  } catch (err) {
    // Non-fatal — dashboard monitoring should not crash the bot
  }
}

// --------------- Commands ---------------

export async function checkDashboardCommands(onKill: () => void): Promise<void> {
  const client = getDashboardClient();
  if (!client) return;

  try {
    const { data } = await client
      .from('bot_commands')
      .select('*')
      .or('bot_name.eq.ict,bot_name.eq.all')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true });

    for (const cmd of data ?? []) {
      if (cmd.command === 'PAUSE') {
        paused = true;
        console.log('⏸ ICT bot PAUSED by dashboard');
      } else if (cmd.command === 'RESUME') {
        paused = false;
        console.log('▶ ICT bot RESUMED by dashboard');
      } else if (cmd.command === 'KILL') {
        await client.from('bot_commands').update({
          status: 'EXECUTED',
          executed_at: new Date().toISOString(),
          result: 'KILL executed — process exiting',
        }).eq('id', cmd.id);
        console.log('💀 KILL command received — exiting');
        onKill();
        return;
      }

      await client.from('bot_commands').update({
        status: 'EXECUTED',
        executed_at: new Date().toISOString(),
        result: `${cmd.command} executed successfully`,
      }).eq('id', cmd.id);
    }
  } catch {
    // Non-fatal
  }
}
