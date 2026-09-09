# Security

This is an unofficial, unsigned Windows preview maintained on a best-effort basis. A passing test or dependency audit is not a complete security review.

## Data and update boundaries

- Client code, Electron and installation tools live in the application directory. Managed Harness versions and client preferences live under the current user's application profile. Harness itself owns its home, credentials, plugins and conversations; workspaces live under Windows Documents by default.
- Client updates use only the public `Coyami-MengLuo/mengluo-dsh-desktop` GitHub release feed embedded in the application. No GitHub token is included. HTTPS, GitHub account/release access controls, and the SHA-512 digest in release metadata are the trust basis for unsigned builds. A digest from the same compromised feed cannot authenticate an uncompromised publisher. Enable account 2FA, protect release permissions, and add Windows code signing before making stronger publisher-authentication claims. The application does not disable certificate verification or override the updater's signature verifier.
- Downloads prefer blockmap-based reconstruction of the installer. The updater verifies the completed installer digest before making it installable. Download or metadata errors do not authorize installation. Installation requires an explicit restart confirmation, and Harness shutdown must finish first. This is not a claim of atomic rollback after power loss during NSIS installation.
- Automatic checking does not download or execute updates automatically. Normal quit does not install them. Portable/development clients do not self-replace. The client refuses downgrade/prerelease metadata and unexpected installer filenames.
- The official UI has no shell preload bridge. The separate local shell/update pages use a sandbox, context isolation and restrictive content policies. Update actions accept only exact local main-frame senders and fixed operations.

## Reporting

Before the repository is published, contact the maintainer through an already established private channel. After publication, use GitHub's private vulnerability reporting feature **only if the repository owner has enabled it**. Do not post secrets, exploit details involving personal data, complete logs or conversations publicly. General non-sensitive defects may be reported as issues.

## Before publishing

Run `npm run check:release`. It checks the allowlisted source tree for common secret patterns and personal absolute paths, but is not a full credential or dependency-code audit. The original private repository and its Git history are not part of this standalone export and have not been approved for publication. Review every added file and any diagnostic attachment separately.
