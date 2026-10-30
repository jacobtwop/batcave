# Batcave: the Bat City newsletter composer

The newsletter composer, hosted on your own Netlify site at batcave.cliftoncreative.agency.
It works the same as the claude.ai version, with a team passcode on the front and drafts kept on the site.

## What is in the folder

- `public/index.html` is the whole composer, one page.
- `netlify/functions/api.mjs` and `netlify/lib/core.mjs` are the small server: the passcode check and the draft storage (Netlify Blobs).
- `netlify.toml` tells Netlify where things are and sets the privacy headers (no search indexing, no framing).
- `package.json` pulls in the one thing the server needs, `@netlify/blobs`.
- `.gitignore` keeps passcodes and local files out of GitHub.

## Setup (about 15 minutes, all yours)

1. **Put the folder on GitHub.** Make a new repo (private is fine) and upload everything in this folder so `netlify.toml` sits at the top of the repo. Dragging the whole folder into the GitHub upload page keeps the structure.
2. **Make the Netlify site.** Netlify, Add new site, Import an existing project, pick the repo. The build settings come from `netlify.toml`, so leave the build command blank.
3. **Set two environment variables** (Site configuration, Environment variables). Keep every scope ticked so the server can read them.
   - `BATCAVE_PASSCODE`: the team passcode. At least 10 characters. Everyone who uses the composer types this one.
   - `BATCAVE_SESSION_SECRET`: a long random string, at least 32 characters. Nobody ever types it. Use a password manager's generator.
4. **Deploy again.** Variables only reach the server on a new deploy (Deploys, Trigger deploy).
5. **Add the domain.** Domain management, Add a domain, `batcave.cliftoncreative.agency`. Netlify shows the address to point at (it looks like `something.netlify.app`). Where cliftoncreative.agency keeps its DNS, add a CNAME record: host `batcave`, value that Netlify address. HTTPS turns on by itself once the record resolves.
6. **Open it** at https://batcave.cliftoncreative.agency and sign in with the passcode.
7. **Bring the Nov 5 draft over.** In the left rail, under Your drafts, choose Restore from backup and pick `batcave-import-from-claude.json`.

## Day to day

- Drafts save as you type and are shared by everyone with the passcode.
- Two people editing the same issue at once: the later save wins. A tab that has changed nothing never overwrites anything.
- Back up all drafts (left rail) saves a file you keep. Restore from backup reads one back. Restoring replaces any issue with the same ID.
- Sign out is in the top bar. Sessions last 30 days.
- To change the passcode, change `BATCAVE_PASSCODE` in Netlify and deploy again. Everyone is signed out and needs the new one.

## If something looks wrong

- "Not set up yet": one of the two variables is missing or too short. Fix it and deploy again.
- "That passcode did not work": check for a stray space. After 10 wrong tries from one address the server asks you to wait 15 minutes.
- Draft stuck on "Could not save": check the connection, then use Back up all drafts so nothing is lost.

## Good to know

- Anyone with the passcode can read, change and delete every draft. Drafts can hold prices, prerelease details and Magic Word lines that still need Brendan's yes, so share the passcode only with people who should see them.
- The page is not listed in search engines and cannot be framed by other sites.
- Netlify's free plan should cover this easily (a handful of people, a few saves a minute while editing). Check your plan's function and storage limits if that changes.
- Nothing here is connected to claude.ai. The claude.ai version keeps working on its own and keeps its own drafts.
