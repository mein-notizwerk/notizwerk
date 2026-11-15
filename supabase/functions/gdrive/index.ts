// Notizwerk – Verbindung zu Google Drive.
// Hält das Client-Secret und das Dauer-Token (Refresh-Token) vom Browser fern:
//   connect    tauscht den Code von Google gegen Token und merkt sich das Dauer-Token für das Konto
//   token      liefert ein kurzlebiges Zugriffstoken (ca. 1 Stunde) – oder { connected: false }
//   disconnect widerruft und löscht das Dauer-Token
// Secrets (Supabase → Edge Functions → Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ message: 'nicht angemeldet' }, 401);

    const id = Deno.env.get('GOOGLE_CLIENT_ID'), secret = Deno.env.get('GOOGLE_CLIENT_SECRET');
    if (!id || !secret) return json({ message: 'Google ist in Supabase noch nicht eingerichtet (Secrets fehlen).' }, 500);
    const google = async (params: Record<string, string>) => {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }),
      });
      return { ok: r.ok, j: await r.json() };
    };
    const body = await req.json().catch(() => ({}));

    if (body.action === 'connect') {
      const { ok, j } = await google({ grant_type: 'authorization_code', code: String(body.code || ''), redirect_uri: String(body.redirect_uri || '') });
      if (!ok) return json({ message: 'Google hat die Verbindung abgelehnt: ' + (j.error_description || j.error || '') }, 400);
      if (!j.refresh_token) return json({ message: 'Google hat kein Dauer-Token geliefert. Bitte noch einmal verbinden.' }, 400);
      const { error } = await admin.from('nw_google').upsert({ user_id: user.id, refresh: j.refresh_token, updated_at: new Date().toISOString() });
      if (error) return json({ message: error.message }, 500);
      return json({ access_token: j.access_token, expires_in: j.expires_in });
    }

    const { data: row } = await admin.from('nw_google').select('refresh').eq('user_id', user.id).maybeSingle();

    if (body.action === 'token') {
      if (!row) return json({ connected: false });
      const { ok, j } = await google({ grant_type: 'refresh_token', refresh_token: row.refresh });
      if (!ok) {
        // Zugriff bei Google entzogen oder abgelaufen → Verbindung vergessen, die App bietet "Verbinden" neu an
        if (j.error === 'invalid_grant') await admin.from('nw_google').delete().eq('user_id', user.id);
        return json({ connected: false, reason: j.error || '' });
      }
      return json({ access_token: j.access_token, expires_in: j.expires_in });
    }

    if (body.action === 'disconnect') {
      if (row) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(row.refresh), { method: 'POST' }).catch(() => {});
        await admin.from('nw_google').delete().eq('user_id', user.id);
      }
      return json({ connected: false });
    }
    return json({ message: 'unbekannte Aktion' }, 400);
  } catch (e) {
    return json({ message: String((e as Error)?.message || e) }, 500);
  }
});
