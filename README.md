# Deepawali House Party Invitation

A fully static, interactive invitation: maroon and gold, mandala art, fairy lights, diyas and fireworks.
Three scrolling sections: **Invitation**, **Dress code**, **RSVP**. No build step, no server, no storage, no external requests.

## Preview
Double-click `index.html`, or run `python3 -m http.server` in this folder and open http://localhost:8000.

## Edit your details (only one file: `js/config.js`)
| Field | What it does |
|---|---|
| `rsvpUrl` | **Paste your Google Forms / Microsoft Forms link here.** Until then the RSVP seal says "coming soon". |
| `rsvpBy` | Reply-by date under the heading ("" hides it) |
| `start`, `end` | Party time, e.g. `"2026-11-14T16:30:00"`. Drives the countdown, the date/time shown and "Add to calendar". Add an offset like `-08:00` to pin a timezone. |
| `venueName`, `venueAddress` | Shown on the invite. With an address, a "Get directions" link appears and the address goes into calendar events. |
| `hosts` | Sign-off at the bottom, e.g. `"Asha and Ravi"` |
| `locale` | Date style: `en-US` (November 14) or `en-GB` / `en-IN` (14 November) |

Dress-code wording and colours live in `index.html` (search for "Dress Code"). The invitation paragraph is in the first section of the same file.

**Personalise per guest:** add `?to=Name` to the link, e.g. `https://your-site/?to=The%20Patel%20Family` shows "Dear The Patel Family,".

## Deploy for free (any static host)
- **Netlify:** drag this folder onto https://app.netlify.com/drop.
- **GitHub Pages:** push to a repo, Settings > Pages > Deploy from branch > `main` / root.
- **Vercel:** `npx vercel` in this folder (framework: Other), or import the repo.
- **Cloudflare Pages:** create a project with direct upload and select this folder.

All links are relative, so it also works under a sub-path like `https://you.github.io/repo/`.

## Before you share it
1. In `index.html`, change `og:image` to the full address of your image, e.g. `https://your-site/assets/og-image.png`, and add `<meta property="og:url" content="https://your-site/">`. WhatsApp and iMessage previews need absolute URLs.
2. The page is marked `noindex` so search engines skip it (your address stays private). Remove that `<meta name="robots">` line if you want it public.

## What's inside
`index.html` · `css/styles.css` · `js/` (`config.js` your details, `main.js` page logic, `fireworks.js`, `lights.js`, `ambient.js` effects) · `assets/art/` (SVG mandalas, diya, lanterns, figures) · `assets/fonts/` (Rozha One + Alegreya, SIL OFL, self-hosted).

Respects "reduce motion" settings, pauses animation when the tab or section is off screen, and works on phones through 4K screens.
