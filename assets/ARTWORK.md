# Application artwork

`icon-source.png` is the application artwork supplied by project maintainer
Coyami-Mengluo. The maintainer reported on 2026-09-10 that the illustration was
generated through OpenAI in their own conversation, and requested its use as the
application icon. The white backdrop was removed locally without generatively
redrawing the character. The PNG contains a real alpha channel; white clothing,
rice, the bowl and the foreground table are preserved.

This artwork is distributed with the MengLuo DSH Desktop source and application
at the maintainer's request. It is **not covered by the source-code MIT grant**.
For other use of this artwork, contact the maintainer. This notice does not claim
exclusive copyright in AI output or grant rights belonging to third parties.
The illustration is not an official DeepSeek logo and implies no endorsement.

The separate geometric `icon.svg` remains available under the project's MIT
license. It is the original placeholder, not the source of the illustration.

The build copies the reviewed PNG to the generated `icon.png` used by Windows
executables, shortcuts, windows and the tray. `scripts/icon-source.mjs` records
its SHA-256 for the source preflight. To replace it, review the replacement's
pixels and metadata, update that digest and this notice, then run
`npm run prepare:icon`, `npm test` and `npm run check:release`.
