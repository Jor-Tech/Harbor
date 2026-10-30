# Local backup retention

Open **Vault & sync → Manage backups → Local backups → Automatic cleanup on this device**. Choose a maximum of **5, 10, 20 or 50** unmarked copies and optionally remove copies older than **30 or 90 days**. The default remains **10 copies with no age limit**. Confirm the deletion policy before saving a changed setting.

Either limit can make a copy eligible: an old copy can be removed even below the count limit, and excess copies can be removed even below the age limit. Newest-first ordering uses the backup filename’s creation timestamp. Saving settings does not immediately delete copies. Default cleanup runs when Harbor creates a backup; after settings or Keep markers have been saved, cleanup also runs on unlock and hourly while the app remains unlocked. It does not run while Harbor is locked or closed.

## Keep and safety copies

**Keep this copy** protects a local recovery copy or an adjacent legacy import copy. Kept copies are additional to the count limit and exempt from age cleanup. Manual deletion is also disabled until you remove Keep. Shared sync history has no Keep markers or automatic cleanup in this batch.

Before deleting anything automatically, Harbor must authenticate at least **three unmarked local copies** with the current vault key and validate their contents. It retains the three newest copies it can verify, as well as the just-created backup and a backup currently being restored. These can be different snapshots of the same revision; they are not necessarily three different days or revisions. Kept copies are extra and do not satisfy this minimum.

After a password change or protection upgrade, cleanup may wait for three copies using the new key. Older-key copies can become eligible once that minimum is available; their original passwords and protection remain unchanged. Files that cannot be read or parsed as supported vault envelopes, copies with another vault identity, legacy import files, and exports are never automatically removed. Older-key candidates cannot be fully authenticated with the current key. A supported header alone is not proof that a backup is recoverable. Counts can exceed the configured limit because of these safeguards.

Cleanup rechecks settings, folder/file identities and hashes, including its safety copies, before each removal. Failures stop further cleanup and appear in Manage backups/Recover backup. Already deleted files cannot be rolled back, and a cleanup failure does not prevent creation of new backups or ordinary vault edits. Failure to create the pre-change backup still stops vault replacement. Locks coordinate Harbor operations; these checks do not provide a transaction against arbitrary external filesystem changes.

## Device-local settings

The policy and Keep identifiers live in `vault.hbr.retention.json` beside this device’s vault. The sidecar contains no SSH credentials or decrypted vault contents, is not encrypted, and is not part of Export or encrypted folder sync. Unix writes use private file permissions; Windows inherits the data directory’s permissions. Configure each device separately.

If this metadata is malformed or unreadable, cleanup pauses and manual deletion of local copies is disabled because Keep protection cannot be established. The UI reports the problem; Harbor does not silently overwrite it. Preserve the file and recovery copies while investigating. Removing this sidecar loses the policy and Keep markers and restores the default policy.

Older Harbor versions do not honor these settings or Keep markers. Make a separate encrypted export before downgrading. Local retention does not manage provider trash/version history, other devices, exported copies, or the active shared vault. Shared-history deletion remains an explicit operation in [Manage backups](backup-management.md). No retained backup is re-encrypted by changing retention settings.

## Validation

Backend tests cover policy validation, stale settings, count/age interaction, Keep protection, the authenticated minimum, password/protection transitions, scope exclusions, malformed metadata, failed writes/deletions and lock/file-change cancellation. The desktop retention smoke test checks settings confirmation, Keep selection protection, backup-triggered cleanup and persisted cleanup on unlock using a disposable profile. Real-device checks are still required on Windows and macOS before release.
