# Manage backup files

Open **Vault & sync → Manage backups** while the vault is unlocked. This view manages recovery copies and this device’s automatic retention settings. It does not upgrade backup encryption.

## Local and shared copies

- **Local backups** lists the recovery points in `vault.hbr.backups` and older adjacent `vault.hbr.backup-…` import backups. The list belongs to this device. Cleaning the folder-sync location does not remove these files on Linux, Windows or macOS.
- **Shared sync history** lists `<vault-id>.history/<hash>.harbor-vault` revisions and `<vault-id>.conflict-…harbor-vault` copies for the unlocked vault in the configured sync folder. The active `<vault-id>.harbor-vault` is excluded. Other vaults, arbitrary files, exports, and the sync provider's trash/version history are not managed.

Each entry shows its date, reason/source, size, verification status, and an expandable **File location**. Shared history has no creation date in its filename, so its displayed date is explicitly the filesystem modification date, which a provider may change. Up to 200 most recent copies are shown per location; the view warns when more exist. Refresh after cleanup to reveal older copies.

## Verify a copy

A file header alone cannot establish that a backup is usable. Entries show **Not yet verified** until **Preview → Verify backup** successfully authenticates/decrypts with that backup's password and validates the vault contents. The verified preview displays collection counts and revision; it never exposes saved credentials or replaces the active vault. A refreshed list clears verification badges because files may have changed. Unknown/damaged formats are labelled explicitly, not marked as verified.

Backups may require an earlier password. The password field is cleared after each attempt and when the preview closes. Locking closes the manager and invalidates its pending operations.

Use **Recover backup** for local restoration, or **Import encrypted vault** for a selected shared copy using its displayed location. Those existing flows retain their own preview/replacement safeguards. Previewing here does not authorize or perform restoration.

## Delete selected copies

1. Make and verify a fresh backup/export before removing copies you may need.
2. Select individual files using their checkboxes. Keep-marked copies must be unmarked before they can be selected for deletion.
3. Choose **Delete selected**. Review the count, total size and exact paths. Shared deletion explicitly warns that recovery on other devices is affected.
4. Check the acknowledgement and confirm deletion. Cancel leaves all files intact. Deletion cannot be undone in Harbor.

The active local and shared vaults are not deletion targets. Harbor requires selections from a recent backend-generated inventory, rejects expired lists or changed locations/files, and coordinates local operations with vault/sync locks. All selected files are checked before the first deletion and each is rechecked before removal. A batch is not a filesystem transaction: if a later removal fails, the UI reports how many were deleted and how many remain. Refresh before attempting a new selection.

Refresh rereads the filesystem, including when files were removed using a file manager. Missing files are no longer listed. Unreadable/oversized files are labelled and cannot be deleted through the manager; symbolic links are not followed. An unavailable shared directory is never recreated by cleanup.

Sync providers do not necessarily honor Harbor's advisory locks across devices. Avoid simultaneous cleanup/editing on multiple devices. A provider or another device can retain or recreate copies; provider trash and previous versions need separate review. Deleting an old copy cannot revoke copies already obtained elsewhere. This feature does not promise secure physical erasure.

Local automatic retention defaults to ten rolling recovery points. Expand **Automatic cleanup on this device** to change count/age limits. **Keep this copy** exempts a local or legacy copy from automatic cleanup and disables its manual deletion until you remove Keep. Shared history remains manual; exported files stay under your control. See [retention settings and safeguards](backup-retention.md).
