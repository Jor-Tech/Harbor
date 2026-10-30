# Vault protection and migration

Harbor 0.4.0-alpha.2 introduces vault envelope format v2. New vaults and password changes use scrypt **N=131072, r=8, p=1**, approximately 128 MiB of KDF memory, following the [OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt) checked on 2026-10-19. The implementation caps scrypt allocation at 256 MiB to allow algorithm overhead. It accepts only two exact version/profile pairs: legacy v1 (`N=32768,r=8,p=1`) and current v2. Imported files cannot choose arbitrary cost or memory parameters. AES-256-GCM, authenticated envelope metadata, 32-byte salts and fresh 12-byte nonces remain in use.

## Upgrade an existing vault

1. Update Harbor to alpha.2 or newer on every device. Alpha.1 and earlier cannot read v2. Preserve an encrypted recovery copy and settle outstanding sync conflicts first.
2. Unlock normally. Reading a v1 vault does not rewrite it; the workspace shows **Vault format update available**. Until upgraded, edits, exports, backups and sync copies retain the original profile.
3. Choose **Update vault format**, read the device/backup explanation, enter the current password and confirm. The operation verifies that password, derives the v2 key, preserves the previous encrypted file and atomically replaces the current vault. The password and contents are unchanged. Wrong passwords, stale files and failure before replacement leave the original current file usable.
4. After the update, verify that the format-update banner has disappeared, then create a new encrypted export from **Vault & sync**. Upgraded current copies, subsequent edits and their exports/backups use v2.

Using **Change vault password** also writes v2, with a fresh salt. Choose a strong, unique password; stronger derivation makes guessing costlier but cannot make a predictable password safe.

## Multiple devices

A same-password protection upgrade retains the existing random salt and vault identity. Devices upgrading copies of that same vault therefore derive the same v2 key, allowing their independently edited branches to be compared and resolved normally after both are upgraded.

After upgrading one device, sync its upgraded copy. On another updated device, upgrade its own legacy copy with the same password before choosing **Sync now** (an earlier authentication error pauses automatic sync), or explicitly import the upgraded shared `.harbor-vault` file with its password. Import replaces local contents, so preserve unsynced edits first. A password change uses a new salt/key; other devices must import the changed shared vault with the new password.

Cross-profile or cross-password data that cannot authenticate fails closed; it is not silently pulled or merged. An exact older shared revision already authenticated in local ancestry can safely be replaced by its upgraded descendant. Unsupported future versions require a newer Harbor client.

## Retained copies and limits

A stronger current vault does **not** strengthen older local recovery points, legacy backups, exports, shared history, conflict files or provider version history. These may contain the same credentials under the older work factor or password. If the password is unchanged, guessing it from an older weaker copy also gives access to the upgraded copy. The pre-upgrade recovery copy is intentionally retained. Once recovery and all devices are verified, decide which old copies to retire using the storage provider's controls; Harbor does not silently delete them. Copies already obtained by another party cannot be revoked. If an old password or copy was compromised, change affected SSH credentials as appropriate as well as the vault password.

Importing or restoring a v1 snapshot preserves compatibility and exposes the upgrade banner again. Backups always need their original password. There is no password reset, remote recovery secret or server able to decrypt the vault.

Encryption protects stored bytes. An unlocked app necessarily holds plaintext and keys in memory, and the authorized renderer sees vault contents. Locking closes sessions and clears the active key buffer, but JavaScript cannot guarantee erasing every historical string copy. Operating-system account protection, trusted binaries and full-disk encryption remain separate layers. Original imported SSH-key files and files downloaded using SFTP are outside the vault.

## Focused validation

Regression coverage checks independently decryptable v2 output, frozen v1 fixtures, strict rejection of unknown/mixed/tampered profiles, password rotation, explicit migration, legacy restore, encrypted export, failure/cancellation preservation, key-buffer cleanup and divergent multi-device upgrades. The desktop protection workflow checks consent, cancellation, wrong passwords, the absence of a format-update banner for a current vault and restart. It joins the existing source and packaged test matrix without adding a separate paid workflow.
