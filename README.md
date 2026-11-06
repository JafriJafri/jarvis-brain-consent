# jarvis-brain-consent

OAuth consent page for Jarvis Brain (static, no secrets)

# Jarvis Brain consent site

Public GitHub Pages site for the Jarvis Brain OAuth consent screen.
Copy the **contents** of this directory to the root of
`JafriJafri/jarvis-brain-consent`. The workflow file is already at
`.github/workflows/pages.yml` so it runs when that repository is the root.

The page uses `@supabase/supabase-js` **2.95.0** (`supabase.auth.oauth`).
`config.js` may contain the project URL and the publishable key. It must
never contain a service-role key, secret key, database URL, or connector token.

Enable GitHub Pages with **GitHub Actions** as the source, then push to
`main`. The consent screen is served at
`https://jafrijafri.github.io/jarvis-brain-consent/oauth/consent/`.

See `docs/brain-oauth.md` in the private Jarvis repository for the Supabase
dashboard values and the deployment order. This public site does not create
Brain owners and does not grant access by itself.

