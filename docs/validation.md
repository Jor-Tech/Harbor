# Validation and device checks

Harbor is preview software. Automated tests use temporary profiles, synthetic credentials and disposable local SSH/SFTP servers. They do not require access to a user's vault or production servers.

## Automated coverage

- `npm test`: encryption and tamper handling, vault migrations, recovery, sync conflicts, SSH authentication and agent/MFA sequencing, forwarding, file operations, MCP permissions and approval lifetimes, and update checks.
- `npm run test:desktop`: source desktop workflows for host management, terminals, transfers, sync, recovery, settings and MCP approvals. This includes responsive layout, keyboard focus and theme checks.
- `npm run test:packaged`: the same workflows against built executables. Release CI runs Linux x64, Windows x64, macOS Intel and Apple Silicon jobs, then validates the complete installer set and checksums before publication.
- `npm run test:release-ui`: opens a frozen encrypted legacy fixture, preserves its contents through restart and verifies update controls. Update responses and browser navigation are stubbed; this test sends no GitHub requests.

Passing source tests does not imply that all packaged builds or physical-device scenarios passed. Consult the workflow for the exact release commit. The fixtures in `tests/fixtures` contain deliberately synthetic values, never production credentials.

## Hands-on device checklist

Use a separate test vault and a disposable SSH account. Record the OS, architecture, Harbor version and result for each scenario; leave untested scenarios marked pending.

1. Install, launch, upgrade and uninstall. Check that the version changes and the existing test vault remains usable. On Windows, test installer destination selection; on macOS, test opening the DMG and copying the app.
2. Unlock, lock, suspend and resume. Verify active sessions close when locking and that MCP needs an explicit resume after unlock.
3. Test password authentication, a selected SSH-agent identity, real password-manager approval and MFA. Reject changed host keys and verify cancellation stops connection establishment.
4. Change a disposable vault on two devices, synchronize, resolve a conflict and recover a backup. Never test recovery by overwriting the only copy of important data.
5. Pair two MCP clients with different test-host rights. Deny a harmless command, approve one once, approve another for the session and save an exact permission. Verify reuse, expiry after client disconnect, and persistence of saved approval after restart. Test file scope boundaries using uniquely named temporary files and remove only those files afterward.
6. Confirm that changing permissions pauses MCP. Check the tray setting, request visibility and explicit app exit on the actual desktop environment.
7. In Settings, use **Check now**, change preview selection, enable automatic checks and restart. Verify the settings persist locally and that a genuinely newer public release produces an update notice. Network errors must not report that Harbor is up to date.

Interactive Windows/macOS installer behavior, real password-manager integrations, suspend/resume and each user's MCP client require hands-on checks. Cross-platform CI does not establish those results. Narrow renderer layouts are desktop checks, not mobile support. Publisher signing and macOS notarization remain separate work.
