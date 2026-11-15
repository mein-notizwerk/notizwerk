// Verbindung zu deinem Supabase-Projekt (Dashboard → Project Settings → API).
// url: Project URL, key: "Publishable key" bzw. "anon public" key.
// Beide Werte sind für den Browser gedacht und dürfen öffentlich sein –
// geschützt werden die Notizen durch die Anmeldung und die Zeilen-Sicherheit (RLS).
window.NOTIZWERK_SUPABASE = {
  url: 'https://disrgcjdirrmjmrhtsoh.supabase.co',
  key: 'sb_publishable_DPOTX7NC23mWNlfbERKhcg_ih77GU3l'
};

// Google Drive als Ablage für Dateien, Fotos und PDFs (siehe supabase/functions/gdrive).
// clientId: OAuth-Client-ID aus der Google Cloud Console – sie ist öffentlich, das Client-Secret liegt nur in Supabase.
window.NOTIZWERK_GOOGLE = { clientId: '' };
