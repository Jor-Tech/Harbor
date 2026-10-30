# Vault backup and recovery

Harbor defaults to ten automatic/manual local recovery points beside the vault, in `vault.hbr.backups`. Before an edit, password change, import, incoming sync update or conflict resolution replaces the local vault, Harbor durably saves its existing bytes. A backup failure stops replacement. **Vault & sync → Back up now** saves the current version without changing it. Frequent edits count as separate recovery points; this is a rolling history, not a daily archive. Configure count/age limits and Keep markers in **Manage backups**. Safety rules can retain additional copies; see [backup retention](backup-retention.md).

Recovery points contain the same encrypted vault format as exports, including hosts, keys, saved credentials, settings, workspaces and trusted server identities. Filenames identify only time and operation. They do not include hostnames or credentials. Files are created with owner-only permissions on Unix; Windows uses the data directory's access controls. Device-only preferences such as the sync folder are not part of the encrypted vault backup.

## Inspect and remove old copies

Use **Vault & sync → Manage backups** to distinguish local recovery copies from shared sync history, check protection, verify contents with the backup password, and delete selected copies after reviewing their exact paths. See [backup management](backup-management.md). Refresh reads the files on disk; cleaning the sync folder does not remove the local recovery list.

## Restore a local recovery point

1. Open **Vault & sync → Recover backup**, or **Recover a local backup** on the locked/create-vault screen. You do not need to unlock the damaged current vault first.
2. Select a backup and enter the password it used when created. **Preview backup** verifies the password and authenticated contents, then displays collection counts. It does not replace or unlock the current vault.
3. Review the counts and check **Replace this device’s vault with this backup**. Choose **Restore this backup**. Cancelling leaves the current file unchanged.
4. Harbor saves the current file first, including damaged bytes when they can be read within the vault size limit, then atomically installs a newly encrypted revision of the recovered data. Active connections close and automatic folder sync is disabled on this device.
5. Review the recovered data before using **Sync now**. A recovered revision branches from the selected backup, so newer shared changes produce a conflict for review rather than silently overwriting your recovered contents. Do not enable automatic sync until the intended contents are settled.

A preview expires after five minutes, after locking, or if the current vault or selected backup changes. Preview again when asked. A wrong password, malformed backup or failed authentication cannot replace the current vault. The selected local backup is retained during recovery, even when it is older than the configured limits.

## Protection upgrades and older backups

An explicit protection upgrade keeps an encrypted pre-upgrade recovery copy. Older snapshots retain their original KDF profile as well as their original password; upgrading the current file does not strengthen copies already exported, synchronized or held by another party. Restoring or importing an old-format vault keeps its original protection and shows the upgrade banner again. See [vault protection](vault-protection.md) before migrating devices or retiring old copies.

## Password changes and older backups

A backup needs its original password. Changing the current vault password does not re-encrypt old recovery points, shared history or exported copies. There is no password reset or service that can recover a forgotten password. Recovering a backup also restores its password; newer contents saved before recovery still need their newer password.

Older Harbor imports created adjacent `vault.hbr.backup-…` files. They appear in the recovery list as older Harbor backups. Count/age retention applies to the new backup folder; legacy files are not automatically removed. Shared-folder history and conflict files are also separate from local retention.

## Protect against device loss

Local backups share the vault's disk and do not protect against losing that disk or the device. Use **Export encrypted vault** to keep a portable copy on separate storage. **Import encrypted vault** can restore an export on an empty or existing device; its password is required and replacing an existing vault requires confirmation. Imports also preserve the existing local file and turn off automatic sync.

If all local copies are missing, use an export or an authenticated shared `.harbor-vault`/history copy. If none survives, Harbor cannot recreate the lost data. Copies of deleted credentials can remain in retained encrypted history.

## Interrupted operations

Writes use a temporary file, flush it, and atomically rename it; an interruption before replacement leaves the original vault intact. The backup is written before replacement. On Windows only the file is flushed, since directory fsync is unsupported. Hardware/filesystem failure can still require restoring another copy.

After an actual process crash, a leftover `.lock` directory can block writes. Close every Harbor process using that vault before removing only the named empty `.lock` directory reported by the error, then reopen Harbor. Do not remove a lock while a process is still using the vault. Do not delete the vault or its backups. Temporary files are not offered as verified recovery points.
