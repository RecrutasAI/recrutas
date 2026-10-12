# Vercel standby

If Vercel is down, the VPS can serve the website and the API itself. **Off by default:**
nothing is built, nothing runs and no port is used until someone runs `up`, so it puts
no load on the box in normal times.

```sh
ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh up'      # ~3-5 min
ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh status'
ssh root@<vps> 'bash /opt/recrutas/app/infra/vps/standby/site-standby.sh down'
```

`up`:

1. Builds the site (`client/` → `dist/public`) from the deployed checkout, with the same
   `VITE_*` settings as Vercel.
2. Starts the API (`standalone-server.js`) as `recrutas-api-standby` on `127.0.0.1:5000`,
   with `VERCEL=1` so it starts no background jobs (the VPS crons already run them) and a
   700 MB memory cap.
3. Has Caddy serve `www.recrutas.ai` (site + `/api/*`) and redirect `recrutas.ai`.

Then **point DNS at the VPS** (A records `www` and `@`). Caddy gets HTTPS certificates
on its own as soon as DNS arrives. When Vercel is back: point DNS back, wait for it to
spread, then `down`.

## Limits

- **DNS is hosted by Vercel** (`ns1/ns2.vercel-dns.com`). If Vercel's DNS is down too,
  the records can't be changed there. Moving the domain's nameservers to a separate free
  DNS host (e.g. Cloudflare) removes that; it's the owner's call.
- One 2-vCPU box serves everything while it's on (database, crons, site, API). The feed
  gate and Autopilot still protect it; expect slower feeds under load.
- Vercel-only features (edge caching headers, preview deployments) don't apply.
