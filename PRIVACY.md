# SquareCMS — Privacy Policy

_Last updated: October 26, 2026_

SquareCMS is a Chrome extension that lets owners, admins and editors of a Squarespace website edit the site's SquareCMS content (text, links and image URLs stored in the site's own footer code injection) from a floating panel, and publish those changes to the site.

## What the extension accesses

- **The page you are on.** When you open the panel, the extension reads the current page's HTML to find SquareCMS `{{tags}}`, the site's published SquareCMS data block, and — if you are signed in to Squarespace — the first name Squarespace embeds in the page for the signed-in account, which is only used to greet you inside the panel.
- **Your Squarespace editor, when you publish.** Publishing opens the site's Code Injection settings page in a background tab, writes the data block, and presses Save, using the Squarespace account already signed in to this Chrome profile. The extension never sees or stores your Squarespace password.

## What is stored, and where

- Your **draft** (unpublished edits), panel preferences, audit results and guide progress are stored **locally in your browser** (`chrome.storage.local`), keyed by site. They never leave your computer unless you export them yourself.
- Published content is written to **your own Squarespace site's** footer code injection. That is the only destination.

## What is NOT collected

- No analytics, telemetry, tracking or advertising.
- No account with us; nothing is sent to our servers (we have none). The only remote resource the extension references is the open-source SquareCMS loader script served from jsDelivr, which the site itself loads.
- No personal data is sold, shared or transferred to third parties.

## Permissions, in plain words

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Open the panel on the tab you click, open the Code Injection tab to publish, and write into Squarespace's code editor on that tab. |
| `storage` | Keep your draft and settings on your computer. |
| `debugger` | Used only while you run *Generate pages*, on the editor tab the extension opened for that, to click Squarespace's Add-a-Page dialog the way a person would. Released when the run ends. |
| Access to all websites (`<all_urls>`) | Squarespace sites live on any custom domain, so the extension cannot know the list of sites in advance. It only acts on a page when you open the panel on it. |

## Removing your data

Uninstalling the extension deletes everything it stored. Inside the panel, *Tools › Forget this site's local data* removes a single site's draft and settings.

## Contact

Kroes Designs — hello@kroesdesigns.com
