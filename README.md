# FONT FINDER

A personal foundry of foundries. Add foundries one at a time: paste a website, or tick one from the list in **Add a foundry** (that list comes from an Are.na board; set `ARENA_CHANNEL` at the top of `app.js`). Only the foundries you add are loaded, and any that can't be read are removed. See every typeface they sell in one grid, with each name set in its own font, a type tester and links to each specimen page.

## How it works

- **`index.html`, `styles.css`, `app.js`**: the website you see. Your foundry list is saved in your browser (localStorage).
- **`api/arena.js`**: reads the Are.na board and returns the foundry websites on it.
- **`api/scan.js`**: when you add a foundry, this runs on Vercel's servers. It opens the foundry's homepage and typeface pages, reads their stylesheets, and finds every `@font-face` rule and font file, like WhatFont or Font Ninja do.
- **`api/font.js`**: browsers block fonts loaded from other websites, so this fetches a font file and passes it to the page. It's used only for previews.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm run dev
```

Then open http://localhost:3000.

To test the scraper on one foundry from the terminal:

```bash
npm run scan -- https://klim.co.nz
```

## Put it on Vercel

1. Create a new repository on [github.com/new](https://github.com/new), named something like `font-explorer`.
2. On the new repository page, click **uploading an existing file** and drag in the files. GitHub can drop folders on upload: if `api/scan.js` and `api/font.js` end up outside an `api` folder, use **Add file → Create new file**, type `api/scan.js` as the name (the slash makes the folder) and paste the file in.
3. Go to [vercel.com/new](https://vercel.com/new), sign in with GitHub, and **Import** the repository.
4. Keep the defaults (Framework preset: **Other**, no build command) and click **Deploy**.

Every time you change a file on GitHub, Vercel publishes the update automatically.

## Good to know

- Some foundry sites block automated visits or load fonts in unusual ways. If a scan finds nothing, try pasting the foundry's "all typefaces" page instead of its homepage.
- Vercel caches each scan for a day, so the second visit is instant. Click ↻ on a foundry to rescan it.
- Previews use the foundries' own web fonts, for browsing only. Buy a license from the foundry before you use a typeface in a project.
