# Desktop builds and installation

Harbor 0.4 targets Linux x64, Windows x64, macOS x64 and macOS arm64.
Windows ARM, Linux ARM and mobile are outside the supported build matrix.
Versioned releases and development previews use the same build pipeline. Installers are not publisher-signed; macOS builds are ad-hoc signed and not notarized.

## Download

For versioned releases, use [GitHub Releases](https://github.com/Jor-Tech/Harbor/releases), also available from **Settings → Releases & updates**. Public release downloads need no repository membership; private downloads require an authorized account. Release assets do not use the 3-day CI artifact retention policy. See [release publishing and upgrade checks](desktop-releases.md).

Pushes to `release/**` branches automatically start [Desktop previews in GitHub Actions](https://github.com/Jor-Tech/Harbor/actions/workflows/desktop-preview.yml). For another branch, choose **Run workflow**, select the desired branch, and start the build. Once it succeeds, download its platform artifact at the bottom of the run page. Private-repository downloads require GitHub access. New artifacts expire after 3 days; existing artifacts keep their original expiration. Opening a PR or merging to `main` alone does not generate installers.

Each artifact contains installers, `SHA256SUMS.txt`, and `BUILD.json` with the source commit and CPU architecture. A failing platform uploads no installer artifact; other successful platforms remain available. Checksums detect accidental changes; they are not a publisher signature.

### Updating a Linux laptop

Quit Harbor before installing a newer DEB, then run `sudo apt install ./Harbor-<version>-linux-amd64.deb` from its download directory. Start Harbor again and check **Settings** for its version. Installing a package does not replace an already running process. Harbor can check for updates automatically when enabled in Settings, but installation remains manual.

If you previously used this repository's `scripts/install-desktop.sh`, run it once again after installing preview.2 or newer. It backs up the old user launcher that pointed into `release/linux-unpacked` and lets the package's launcher take over. Future DEB upgrades then update the app launched from the drawer. The package executable is `/opt/Harbor/harbor-terminal`; the existing per-user vault remains in the same location.

Preview.1 packaged only a 1024-pixel icon, which some hicolor themes do not index. Preview.2 includes standard sizes from 16 to 512 pixels, an explicit desktop identity, and a window icon. CI inspects the DEB's launcher and icon files as well as testing the packaged application.

| Platform | Output | Installation limitations |
| --- | --- | --- |
| Linux x64 | AppImage, DEB | AppImage may require executable permission and FUSE support. DEB is for Debian/Ubuntu distributions. |
| Windows x64 | NSIS EXE installer | No publisher signature; Windows may show an unknown-publisher/SmartScreen warning. |
| macOS Intel | DMG, ZIP | Ad-hoc signature only; no Developer ID signature or Apple notarization. |
| macOS Apple Silicon | DMG, ZIP | Ad-hoc signature only; no Developer ID signature or Apple notarization. |

On macOS an ad-hoc signature allows native code to execute but does not establish a trusted publisher. Downloaded builds may be blocked by Gatekeeper. Do not disable OS-wide security protections. Signing and notarization are a later release task.

## What the pipeline verifies

Pull requests run **Pull request checks / Linux checks**: locked dependency installation, backend tests, the renderer build, native Electron dependency preparation, and all source desktop smoke workflows on Linux. This job does not package or upload installers. Superseded PR checks are cancelled. Merges and other pushes to `main` do not trigger another build. If branch protection is enabled, require **Linux checks**, not the manually triggered platform jobs.

Pushes to `release/**`, manual **Desktop previews** runs and release tags execute the full native runner matrix. Use a release branch or request a manual preview before merging changes to packaging, native dependencies, or Windows/macOS-specific behavior when early platform validation is useful. Each full-build job:

1. Installs the lockfile with the Node.js version pinned in `.nvmrc` (26.13.0 LTS) and applies the verified ssh2 MFA correction.
2. Runs backend tests, including real loopback SSH/SFTP, agent signing followed by MFA, and a common encrypted vault fixture.
3. Rebuilds native modules for Electron and runs all desktop smoke workflows with temporary profiles.
4. Packages for the runner's native architecture.
5. Runs the same desktop workflows against the packaged executable, then generates checksums and uploads installers.

The Windows job also compiles the installer hooks and executes destination-validation checks against disposable folders, including an NTFS write denial. The installer rejects Program Files for per-user installs before replacing an existing version. Other custom destinations are allowed when the preflight can write to the nearest existing directory. For Program Files choose installation for all users and approve UAC.

The Linux job also runs `npm run test:tmux` against a disposable OpenSSH/tmux Docker fixture to verify process survival, remote session identity, lock/unlock restoration and targeted termination.

The synthetic agent uses Unix sockets on Linux/macOS and a Windows named pipe on Windows. Unix permission assertions run on Unix; Windows access controls have different semantics. The common vault fixture contains only a synthetic `.example.test` host and uses the public test password `portable-fixture-password`.

The preview workflow has read-only repository permissions and does not publish releases, use signing credentials, or touch real vaults. It also validates the complete release asset set. The separate tag-triggered release workflow publishes only after the same checks pass; its final publishing job alone has write access. Official actions are pinned to commit SHAs. Linux GUI tests use Xvfb. Package jobs use GitHub-hosted runners and count toward the repository's Actions allowance.

## Local commands

```sh
npm ci
npm test
npm run build
npx electron-builder install-app-deps
npm run test:desktop
npm run dist:preview
npm run test:packaged
node scripts/preview-manifest.cjs
```

Run these on the target operating system with a desktop session. On headless Linux, prefix each desktop test command with `xvfb-run -a`. Preview packaging uses `preview/` and leaves the existing `release/linux-unpacked` installation alone. Rebuild native dependencies after changing Electron versions or architectures.

## Device checks before declaring support

CI validates synthetic authentication and packaged startup; it does not certify 1Password integration or a complete installer lifecycle on personal devices. Verify on representative machines:

- Install, launch from the OS launcher, upgrade, uninstall, and retain the user's vault.
- Approve a real 1Password signing request, enter server MFA, cancel each prompt, and retry.
- Lock/suspend closes sessions and clears pending authentication. On macOS, closing the window locks and hides Harbor; opening it from the Dock shows the locked window. Quit exits the app.
- Test local terminal input/resize, native copy/paste, keyboard shortcuts, file-picker and desktop drops.
- Transfer nested directories and overwrite/cancel safely; include Windows drive and UNC paths when applicable.
- Import the same encrypted vault on another OS and exercise two-device sync/conflict resolution with disposable data first. Device-specific custom agent paths and local terminal environments are not portable; use the 1Password provider to select its endpoint per OS.

Platform support claims should reflect the device checks actually completed. Publisher-signed desktop releases, automatic updates, and mobile clients are separate milestones.

For hands-on preview testing, follow [validation and device checks](validation.md). Vault recovery is described in [Backup and recovery](vault-recovery.md).
