# Desktop releases

The release pipeline publishes only to the repository where it runs; it does not change repository visibility. Release assets are separate from the 3-day CI artifacts. The public update endpoint is fixed to `Jor-Tech/Harbor`.

## Find and install an update

Open **Settings → Releases & updates** to see the running version, platform and architecture. **Check now** checks the public GitHub releases API. **Automatically check for updates** is off by default; enabling it schedules a check after 30 seconds and every 12 hours while the app is running, including in the system tray. **Include preview releases** initially follows the installed version: enabled for a preview, disabled for a stable version. Both preferences are stored locally in `updates.json`, separately from the vault and its sync settings.

Harbor compares semantic versions, including numbered alpha/beta versions, and requires a published installer for this device's operating system and architecture. Drafts and releases without a matching installer are ignored. An available newer version adds a titlebar notification; selecting it opens Settings. **View update & download** opens that release's fixed GitHub page in the system browser. **View releases & downloads** remains available at all times.

Requests use the public API without GitHub tokens, cookies, vault contents or host information. GitHub receives the network request, including the device's public IP address. Repeated checks share the current result for at least 60 seconds; rate limits can extend that delay. Network, private-repository and incomplete-response errors are shown as errors, never as confirmation that Harbor is up to date. If the repository is still private, use the browser link with an authorized GitHub account. A channel with no compatible releases is reported explicitly.

Harbor does not download or install updates or restart itself. Disabling automatic checks stops the timer and cancels a pending check; manual checks remain available.

Quit the running app, install the new package, reopen it, and confirm the version in Settings. Export an encrypted backup from **Vault & sync** when a separate recovery copy is desired. Keep the same Harbor data directory; app replacement and vault import are different operations. The existing data paths, application ID and vault format are unchanged.

## Publish a version

1. Update `package.json` and `package-lock.json` to the same version, and add `docs/releases/<version>.md`. Include changes, installation instructions and known limitations.
2. Push a `release/<version>` branch and open a PR. Wait for **Linux checks**, **Secret checks**, and **Desktop previews** to pass on the latest commit. Release-branch pushes automatically build all four targets and validate the complete asset set without publishing. Other branches can start **Desktop previews** manually.
3. Merge to `main`. After checking the intended commit, create and push its exact version tag, for example `v0.4.0`. Use the normal signed-tag workflow if configured. Do not move or reuse release tags.
4. The **Desktop release** workflow rejects mismatched tags or commits outside `main`, runs the complete desktop pipeline at the tagged commit, and publishes only after all four desktop jobs and **Complete release assets** succeed. That final validation combines the real platform artifacts and checks installer names, checksums, versions and source commits.

Merging to `main` does not start another desktop build. Full platform builds run for release-branch pushes, manual previews and release tags; routine feature PRs run Linux checks and the secrets scan. A new push cancels an older preview for the same branch. A failed release build never publishes incomplete installers.

The build jobs have read-only repository permissions. Only the final publish job receives `contents: write`, using the built-in GitHub Actions token. No personal access token or publisher-signing credentials are needed. The pipeline validates all four platform manifests and all seven installers, assembles one `SHA256SUMS.txt` and `BUILDS.json`, creates a draft, uploads the complete asset set, and publishes it. Versions with a prerelease suffix are marked as GitHub prereleases.

A failed build publishes nothing. A failed upload leaves a draft: inspect the failure, delete only that incomplete draft in GitHub (keep the tag), then rerun the failed workflow. The publisher does not overwrite an existing release or its assets. A successful published release should be corrected with a new version, never by silently replacing installers.

## Upgrade validation

Every source and packaged desktop run includes `test:release-ui`. It opens a frozen encrypted fixture written by preview.7, verifies all collections and credentials, checks that unlocking alone does not rewrite the vault, changes a setting, restarts the app, and verifies the saved data and device preferences. Wrong-password handling, fixed browser navigation, update detection, preview selection, device-only preference persistence, titlebar notification navigation, private-repository errors and compact layout are also tested. Update responses and browser navigation are stubbed; these tests never contact GitHub. Backend tests additionally cover semantic ordering, platform assets, pagination, response limits, cancellation, scheduling and rate limits. Only synthetic data is used.

On an ephemeral GitHub Linux runner, `check-linux-upgrade.cjs` additionally installs the newest available older published DEB from the recent releases listing, opens and saves the synthetic profile with that version, installs the new DEB, and checks the same profile across restart and package removal. For the first published release there is no previous DEB baseline: the job explicitly reports that it tested first installation with the preview.7 profile instead. It never runs on a developer laptop.

Windows and macOS installer lifecycle checks still require representative devices. Their CI jobs test the packaged executables and existing-profile compatibility, but do not claim to test an interactive NSIS or DMG upgrade.

## Signing and visibility

Installers are not publisher-signed (macOS ad-hoc signed, not notarized), including releases without a prerelease suffix. Checksums help detect changed bytes; they do not establish publisher identity. OS warnings and Gatekeeper restrictions remain possible. Publisher signing, notarization and automatic update installation are separate work. Do not disable system-wide protections to install Harbor.

## Release readiness

Review [validation and device checks](validation.md) and explicitly record untested scenarios for each release. Automated platform builds do not establish real password-manager approval, suspend/resume or interactive installer behavior. See [vault backup and recovery](vault-recovery.md) for recovery behavior and password requirements.
