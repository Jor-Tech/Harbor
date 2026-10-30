# Synthetic vault fixtures

`portable-vault.json` is the original cross-platform encrypted fixture. Its password is `portable-fixture-password`.

`upgrade-preview7-vault.json` was created using the unchanged vault implementation from commit `eb1ccfd3b173da46427ca4ae5aae81987dbd3cb8` (0.3.0-preview.7). Its password is `upgrade-fixture-password`; `upgrade-preview7-expected.json` contains its expected plaintext. Every address, password, key placeholder and identity is synthetic and must never be used to authenticate. The fixture includes all persisted collections and host browsing preferences.

Keep these fixtures frozen. The release UI test copies the old encrypted bytes into an existing profile, opens them with the new app, verifies that unlock does not rewrite them, changes one preference, and restarts to check all collections and device settings survive. This checks application/data upgrades; it does not stand in for OS installer lifecycle checks.
