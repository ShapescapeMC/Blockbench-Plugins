# Working in this repository

## Licensing, third-party code and credits

Check these on every change, not only at release.

- **This repo is GPL-3.0.** Code taken from elsewhere must be GPL-3.0 compatible
  (GPL-3.0, LGPL, MIT, BSD, Apache-2.0, ISC, public domain). Do not copy code
  under unclear, non-commercial, or "no license" terms.
- **Copied or adapted code:** keep its copyright and licence notice next to it,
  and add a line to the plugin's `Credits` header comment with the project, a
  link, and the licence.
- **Reimplemented from reading another project** (no code copied): a courtesy
  line under `Credits` is enough.
- **Bundled libraries or assets** (icons, fonts, images): list each one with its
  source and licence in the plugin's README, and keep the licence text with it.
- **Tools used only for testing** (Playwright, local Blockbench builds, sample
  models) don't need crediting, but never commit third-party or client files
  (for example models or textures from a project) into this repo.
- **AI assistance:** commits keep the `Co-Authored-By` trailer. Every plugin
  header says it was written with AI assistance.
- Before finishing a task, say in the summary whether any outside code, assets
  or references were used, and how they are credited.
