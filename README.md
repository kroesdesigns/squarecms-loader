# SquareCMS loader

The one script every SquareCMS site loads. It swaps `{{tags}}` for the values in
the site's `OSCMS:data` footer block on the live site, and shows the Studio
extension's draft values in the Squarespace editor preview. No UI — editing
lives in the [SquareCMS Studio](../squarecms-studio) Chrome extension.

Client sites load it from jsDelivr, so you update every site by pushing here:

```html
<script src="https://cdn.jsdelivr.net/gh/OWNER/REPO@release/os-cms-loader.min.js"></script>
```

SquareCMS Studio writes that tag into a site's Footer code injection with one
click (*Guide › Site setup* or *Tools › Install SquareCMS*). Nobody uploads a
file to Squarespace.

## Set up once

1. Create a GitHub repo (public — jsDelivr serves public repos only) and push
   this folder to `main`.
2. In `squarecms-studio/lib/core.js`, set `LOADER_REPO` to `"OWNER/REPO"`.
3. Push the first release: `git tag v1.0.0 && git push --tags`.
   The `release` workflow builds `os-cms-loader.min.js` and publishes it to a
   `release` branch. That branch is what the tag above points at.

## Ship an update

```
# edit os-cms-loader.js on main, bump LOADER_VERSION, commit
git tag v1.1.0 && git push && git push --tags
```

- jsDelivr caches branch files for up to **12 hours**, so every site is on the
  new build within half a day with no action from you or the client.
- Need it on one site *now*? In SquareCMS Studio on that site, *Tools ›
  Site install › Update now* rewrites the tag to the exact version
  (`@v1.1.0`, cached forever) and then back to `@release` on the next
  install — or just leave it pinned.
- Studio shows the installed version (the loader stamps
  `data-oscms-loader="v58"` on `<html>`) and the newest tag on GitHub, so you
  can see which sites are behind.

## Why a `release` branch and not `@1`

jsDelivr caches semver ranges like `@1` for 7 days and only clears them
early through a purge API that needs an email-granted key. A branch refreshes
in 12 hours on its own. Exact versions never change, which is what makes the
instant per-site update safe.

## Local build

```
npm install
npm run check && npm run build
```

`npm run build` needs terser; the committed `os-cms-loader.min.js` is
rebuilt by the workflow on every tag, so you don't have to commit it by hand.

## Compatibility

Reads v3–v57 data blocks unchanged. Sites still running the old v57 loader
(with its built-in panel) keep working; Studio hides that panel when it's open.
