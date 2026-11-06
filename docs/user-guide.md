# Using Harbor

Practical details for SSH authentication, workspaces, file transfers, vaults and synchronization. Start with the [README](../README.md) for installation and first launch. MCP setup is covered in the [agent guide](mcp-agent-guide.md).

## SSH keys, 2FA and password managers

Harbor supports **public-key authentication followed by SSH keyboard-interactive authentication**, including OTP/2FA prompts. The same authentication flow is used for SSH terminals and forwarding; SFTP reuses the authenticated connection.

For a passphrase-protected private key, import it into **Keychain**, then select it in the host editor. You may save its passphrase in the encrypted vault or leave it blank: Harbor prompts when connecting. A separately requested server 2FA code appears in a subsequent **SSH verification** dialog. Server prompts can contain multiple fields and successive rounds. Responses entered in these dialogs are transient and are not written to the vault, history, or logs. Cancel, vault lock, or closing the connection dismisses pending prompts. Interactive prompts time out after two minutes; the SSH handshake has a three-minute limit.

The host and group **Account password** field is for the SSH account's server login password. Leave it blank to enter the password when requested; configure an imported SSH key's passphrase separately in **Keychain**. If the server requests a separate account password, Harbor prompts for it even when it is not saved. Authentication follows the server’s advertised methods and retains completed factors. This server password is distinct from a private-key passphrase.

For **1Password** on desktop:

1. Enable the SSH agent in 1Password's developer settings and make your SSH key available to that agent.
2. Edit a Harbor host and select **SSH agent → 1Password**. Harbor selects the platform endpoint directly, including when started from an application launcher: Linux `~/.1password/agent.sock`, macOS `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`, or Windows `\\.\pipe\openssh-ssh-agent`.
3. Leave the optional agent-key fingerprint empty to choose an identity when multiple keys are available, or pin a `SHA256:…` public-key fingerprint.
4. Use **Save & connect** in the host editor to apply the shown settings, then approve the signing request in 1Password. If the server also requires 2FA, enter that code in Harbor's subsequent prompt.

The private key remains in the agent/password manager. Harbor requests public identities and signatures; it does not export or import those private keys. **System SSH agent** uses the inherited `SSH_AUTH_SOCK`, falling back to the OpenSSH named pipe on Windows. **Custom SSH agent** accepts an absolute Unix socket path or `~/…` on macOS/Linux, and a local `\\.\pipe\name` endpoint on Windows. On Windows, 1Password and the Windows OpenSSH service share the default endpoint; configure 1Password as its provider in 1Password’s SSH-agent setup. Selecting an agent overrides the host's vault-key selection. Each connection offers only the selected identity, avoiding attempts with every key in a large password-manager vault. No agent forwarding is enabled.

See [1Password agent setup](https://www.1password.dev/ssh/agent) and [client configuration](https://www.1password.dev/ssh/agent/compatibility). 1Password must have an eligible SSH key and its agent enabled; this implementation is protocol-tested with a local signing-agent fixture, not certified by 1Password. Desktop MFA tests use a local SSH server and synthetic keys/codes, not your real accounts.

On authentication failure, Harbor shows the account, selected public-key fingerprint, signing request/result, accepted factors, and remaining server methods. No password, private key, or verification code is recorded. The dialog is cleared on close, reconnect, or vault lock. If no signature was requested, compare the selected public-key fingerprint with the key authorized on the server for that username. A 1Password key is unlocked/approved in 1Password; Harbor does not ask for its original key passphrase.

The build pins `ssh2` 1.17.0 and applies `scripts/patch-ssh2.cjs` on install/build/test. This narrowly preserves partial success and the remaining authentication methods before the library advances past agent authentication. The script verifies the upstream source hash and requires review on dependency upgrades.

## Workspaces, groups and files

Use **Split right** or **Split below** in the terminal toolbar, choosing a new host/local terminal or an existing tab. Drag a divider (or focus it and use arrow keys) to resize. **Focus pane** shows one terminal while retaining the layout. **Save workspace** stores up to eight pane references and split proportions in the encrypted vault. Open it from **Workspaces** to create fresh connections; it does not resume remote processes or store MFA responses. Broadcast is off by default and after a layout change. Select target panes explicitly, then enable broadcasting; input typed in any selected pane goes to all selected panes.

A group can have a parent and defaults for username, port and a credential bundle. Hosts independently opt into **Inherit username**, **Inherit port**, and **Inherit credentials**. The nearest group override wins. Existing hosts keep their own values until you opt in. The editor previews inherited values. Cycles and more than 16 group levels are rejected. Deleting a group reparents its children and preserves their effective settings.

In **SFTP**, select a connected SSH session and a local folder. Select files or directories, then upload/download, drag between panels, or drop files from the desktop onto the remote panel. Transfers run sequentially with progress and cancellation. Existing files are not replaced unless you enable replacement and confirm. Completed files remain when a directory transfer is cancelled; in-progress temporary files are cleaned up. Symlinks and special files are not followed, and a transfer is limited to 20,000 entries/32 levels. Uploaded files are private by default (0600); use **Permissions** to change them. Replacement and editor saves require the server's OpenSSH atomic-rename extension; unsupported servers report an error without removing the existing file.

Double-click a remote file, or select it and choose **Edit text**, to edit UTF-8 text up to 1 MiB. Save rechecks the original content hash before replacing the file. This catches concurrent changes but is not a distributed lock. The editor keeps Unix permissions; replacement creates a new inode owned by the connected account and does not preserve ACLs, extended attributes or hard-link identity. Remote delete removes files and empty directories only.

## Jump hosts and forwarding

In a host's editor, **Connect through** selects a saved bastion. If that bastion has its own jump host, Harbor follows that route from the outside in, up to eight jump hosts. Each hop uses its own effective group settings, credentials, agent selection and MFA. Each server key is independently verified. The target connection, SFTP and forwarding all use the same configured route. Private target names are resolved from the preceding jump host. No SSH agent forwarding or private-key copying is needed.

Cycles and missing jump hosts are rejected. Change dependent hosts before deleting a bastion. Closing a terminal, stopping a forwarding rule, locking the vault, or losing any hop closes that route and its sockets. Connections are independent: stopping one route does not close a separately opened terminal to the same bastion.

**Port Forwarding → New rule** supports:

- **Local tunnel:** listens on this device's `127.0.0.1`, then reaches the destination from the selected SSH server. A destination of `127.0.0.1` means the SSH server itself.
- **Remote tunnel:** requests a listener on the SSH server's `127.0.0.1`, then reaches the destination from this device. A destination of `127.0.0.1` means this laptop. The SSH server must permit forwarding and honor loopback binding; administrators should not force wildcard bindings with `GatewayPorts yes`.
- **SOCKS5 proxy:** listens on this device's `127.0.0.1` and supports TCP CONNECT to IPv4, IPv6 and domain destinations. Configure the client application to use proxy-side DNS (for example, curl's `--socks5-hostname`). UDP, SOCKS BIND and SOCKS4 are not supported. The loopback proxy has no separate authentication, so other local applications can use it while it runs.

Set the listen port to `0` for an available port; the running card shows the actual port. Rules are saved encrypted, but do not start automatically after unlocking. Existing local-forwarding rules continue to work. SSH channel/listener requests and SOCKS negotiation have 30-second limits; interactive SSH authentication retains the existing prompt timeouts.

## Your vault

Create your own password on first launch. It must contain at least 12 characters. No default password or sample credentials are installed. The password cannot be recovered by Harbor.

The vault is stored in Electron’s per-user Harbor data directory: normally `~/.config/Harbor/vault.hbr` on Linux, `~/Library/Application Support/Harbor/vault.hbr` on macOS, and `%APPDATA%/Harbor/vault.hbr` on Windows. Data uses AES-256-GCM with a fresh nonce per revision; new format-v2 vaults use scrypt N=131072, r=8, p=1 (128 MiB) and a random 32-byte salt, matching an OWASP-recommended profile. Format-v1 vaults remain readable with their original N=32768, r=8, p=1 profile until explicitly upgraded. Authenticated metadata includes the vault identity and revision ancestry. Writes use a flushed temporary file and atomic replacement. Unix files use mode 0600; Windows files inherit the access controls of their per-user directory. Windows does not support the additional directory fsync used on Unix. Hostnames, passwords, keys, snippets and connection history are encrypted together. The app clears its active encryption key and disconnects terminals on manual lock, the configured inactivity timeout, OS screen lock or suspend. **Settings → Lock when inactive → Never** disables only the inactivity timeout; it does not disable the other lock triggers. JavaScript garbage collection does not guarantee erasure of every prior string copy from process memory.

Use **Update vault format** on the workspace banner to upgrade an existing vault with its current password. Update Harbor on all devices first: alpha.1 and older cannot open format v2. Opening a legacy vault alone does not rewrite it. Password changes also apply the current profile. See [vault protection and migration](vault-protection.md) for multi-device steps and the limits of retained backups.

Backups can be inspected and selectively removed through **Vault & sync → Manage backups**. Local recovery files and shared sync history are shown separately, with protection labels and password-verified previews. See [backup management](backup-management.md).


The per-device sync folder selection is stored separately in `device.json` alongside the local vault. It is not shared between devices.

## Folder sync across devices

1. Set up a folder synchronized by your chosen file-sync service, or use a shared filesystem.
2. In **Vault & sync**, choose that folder and click **Sync now**.
3. On another device, import the `<vault-id>.harbor-vault` file and supply the same vault password. Select that device's corresponding sync folder.
4. Click **Sync now**, or enable **Automatically sync on this device**. Automatic sync runs while Harbor is open and unlocked, two seconds after edits and every 30 seconds. The preference stays on this device; your folder-sync software transports only encrypted files.

When one version descends from the other, Harbor pushes or pulls it. Separate edits on two devices produce a preserved encrypted conflict copy. Choose **Compare changes** to review changed hosts, groups, keys, snippets, forwarding rules, workspaces, settings, trusted identities and history. Choose this device or the shared version for each item; missing entries can be kept absent. Credentials and command contents remain hidden. Bulk choices are available, but applying still requires a current comparison. Both originals remain in encrypted history; the resolved revision includes both ancestries so other devices can fast-forward. This is per-item selection, not a per-field or automatic three-way merge.

Automatic sync pauses on conflicts and errors until you review them or retry with **Sync now**. Locking, suspending, and quitting stop automatic work; an unavailable folder is not recreated. Changing the sync folder or importing another vault turns automatic sync off. Background pulls refresh the workspace, and stale editor saves are rejected instead of overwriting a newer item. A comparison becomes invalid if either vault changes; refresh it before applying. Selected key/host/group dependencies must remain valid.

Immutable encrypted copies are stored in `<vault-id>.history/`. Do not delete them until you have verified your backups. Generic folder-sync services can deliver stale files or concurrent changes; Harbor preserves revisions but does not claim distributed locking or rollback-proof storage. After changing the password, sync it and import the new shared vault on other devices using the new password. Old backups still require their original passwords.

### Host organization

On **Hosts**, use **Sort by** for name (including numeric names), group, address, creation date, last update, or last connection. The arrow reverses the order. **Filters** combines a group, tag, host color, favorites, and an inclusive creation-date range; the search box also matches group paths and inherited usernames. Dates use local time. Unknown dates stay last in either sort direction; creation-date filters exclude them. Older hosts have no reliable creation date, so Harbor leaves it unknown. Newly added and SSH-config-imported hosts record their creation time once, preserving it through later edits. Last connection uses retained connection history.

**Hosts page** chooses **All hosts** (the existing default) or **Groups and ungrouped hosts**. The second mode shows top-level groups and ungrouped hosts, then child groups and directly assigned hosts when opening a folder. Search, favorites and active filters also find hosts in subgroups, within the selected group. Breadcrumbs let you move back up. The same preference is available in **Settings**. Home-view and sort preferences are saved in the encrypted vault and sync with it; transient filters clear when navigating away or locking.

Choose **Group color** when creating or editing a group. It appears on folder cards, sidebar folders, and host group labels. Host colors remain independent.

### Terminal copy, search and reconnect

Select terminal text and press **Ctrl+Shift+C** on Linux/Windows or **Cmd+C** on macOS to copy it. Paste with **Ctrl+Shift+V** or **Cmd+V** respectively. **Ctrl+C** remains the shell interrupt shortcut. Copying without a selection leaves the clipboard unchanged; terminal copying is limited to 100,000 characters.

Use the terminal toolbar’s search button, **Ctrl+Shift+F** on Linux/Windows, or **Cmd+F** on macOS. Search covers the active terminal buffer (up to 10,000 scrollback lines), including wrapped lines. Enter finds the next match, Shift+Enter the previous match, and Escape closes search. Case and whole-word filters are optional; highlights are capped at 1,000 matches. Each split pane has its own search.

Disconnected tabs keep their scrollback and workspace position. **Reconnect** opens a new SSH shell using the saved host’s current settings and jump route; **Restart shell** starts a new local shell. Input typed while disconnected is discarded. Commands and file transfers are never replayed automatically. Use `tmux` on the remote server if you want a persistent remote shell.

**Auto reconnect this tab** is off by default and applies only until that tab is closed or the vault locks. After a transport interruption, Harbor waits 2, 5, 10, 20, and 30 seconds between up to five attempts. The retry budget resets after a connection remains established for a minute, or when you choose Reconnect manually. Each attempt performs server identity checks and authentication again, including 1Password approval and MFA when required. The countdown and Cancel reconnect control remain visible. Authentication cancellation/failure, a rejected host key, normal shell exit, Disconnect, closing the tab, locking the vault, and suspend do not trigger retries. Disabling auto reconnect cancels a pending attempt. Reconnecting turns off input broadcasting; re-enable it explicitly if needed.

The terminal usability workflow (`npm run test:terminal-ui`) runs against an isolated local SSH server and temporary vault. It exercises copy/paste, shell interrupts, search, retained scrollback, split panes, local shell restart, network interruption, repeat MFA, cancellation, and lock cleanup. It also runs against packaged desktop previews.

### Import an SSH configuration

From **Hosts → Import SSH config**, choose a configuration text file and review the named hosts before saving. Harbor applies matching `Host` patterns (including negations), first-obtained `HostName`, `User`, `Port`, `IdentityAgent`, and a single named `ProxyJump` alias. Wildcard sections provide defaults; they do not create hosts. Select dependent jump hosts too, or import them first. Existing hosts are never overwritten; duplicates start unselected and require explicit confirmation to add another copy.

This is a static importer, not an OpenSSH interpreter. `Include` files and `Match` sections are skipped and reported; no configuration commands are executed. Import included files separately and review omitted defaults. Unsupported connection-changing `ProxyCommand`, canonicalization, and complex `ProxyJump` forms block that host. Other unsupported options require acknowledgement. Private key files are never read by this importer: select a saved Harbor key, 1Password/system agent, or configure authentication later. See the [OpenSSH configuration reference](https://man.openbsd.org/ssh_config) for the original option semantics.

## Persistent SSH sessions with tmux

Enable **Keep remote sessions running with tmux** in each host's connection settings. It is off by default. Harbor checks for `tmux` on the target host after the normal SSH authentication and host-key verification, including jump hosts. The remote account needs a POSIX shell and an existing tmux installation supporting `new-session -A`; Harbor never installs it. An unavailable tmux stops the connection with an error, without falling back to a different shell.

Each new terminal or split pane gets its own `harbor-…` session name. Manual and automatic reconnect attach to that same session. **Save workspace** records the references inside the encrypted vault, allowing the workspace to resume them after Harbor restarts or the vault is unlocked. Ordinary tabs are not automatically restored after app restart; save a workspace first. Opening a saved workspace twice attaches both sets of panes to the same remote sessions. Disabling the host option blocks restoration of existing persistent references until you enable it again.

- **Disconnect**, closing a tab, quitting Harbor and vault lock close the SSH transport and leave tmux processes running remotely. Reconnect still requires authentication and server identity verification. Lock cancels pending connections and retry timers.
- **End remote session** requires a connected terminal and confirmation. It kills only that terminal's tmux session and its processes; other clients attached to that same session disconnect too. To end an offline session, reconnect first.
- If the session has ended (including after a server reboot), reconnect creates an empty session under the same name. Harbor never replays commands or buffered input. Remote tmux configuration can affect session lifetime; persistence is not a process backup.

Deleting a saved workspace does not kill its remote sessions. A saved reference is a tmux session name, not an authentication credential. Changing a host's server or SSH account changes where that reference is resolved. The session is accessible to other clients with access to that same remote account. Vault lock protects Harbor's credentials and closes its connections; it does not stop jobs you explicitly chose to keep running remotely.

## Command palette

Press **Ctrl+K** on Linux/Windows or **⌘K** on macOS from any unlocked workspace page or terminal. You can also click the search icon in the titlebar. Search across saved hosts (name, address, username and tags), open terminal tabs, saved workspaces and actions such as opening Settings, adding a host, opening a local terminal or locking the vault. Search ignores case and accents, supports multiple words, and prioritizes exact names. It does not index passwords, private keys, host notes or snippet commands.

Use **↑/↓** to select, **Enter** to open, and **Esc** to cancel and return focus. Clicking a result also works. The result type distinguishes a saved host from an already open terminal with the same name. Choosing a host opens a connection; choosing an open terminal focuses its existing tab; choosing a workspace uses the normal workspace restore flow, including saved tmux references. Search never runs a shell snippet. With more than 100 matches, refine your search to see the remaining entries.

The palette does not open over an active dialog or the expanded narrow-window navigation. Authentication and other dialogs that appear while searching take priority. While a connection is being opened, additional connection actions are disabled. Vault lock closes the palette, clears its search and removes the searchable vault data until unlock. Normal SSH authentication, host-key checks and confirmation dialogs remain in force.
