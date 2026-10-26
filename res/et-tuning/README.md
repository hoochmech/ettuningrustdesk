# ET Tuning Remote Client

East Texas Tuning's branded build of [RustDesk](https://github.com/rustdesk/rustdesk), for Windows.

## Where the branding lives

| What | Where |
| --- | --- |
| App id, display name, ID/relay server, server key, update repo | `src/branding.rs` |
| Display name and links in the UI | `flutter/lib/branding.dart` |
| Exe file properties | `Cargo.toml` (`[package.metadata.winres]`), `flutter/windows/runner/Runner.rc` |
| Icons, logo, installer art | generated from `res/et-tuning/logo-source.jpg` |
| Update-signing public key | `src/update_metadata.rs` (`TRUSTED_UPDATE_KEYS`) |
| Windows build and release | `.github/workflows/et-tuning-windows.yml` |

The ID server, relay server and key are locked: users can see them in settings but
cannot change them. To move to a new server, change `src/branding.rs` and ship a
release; installed clients pick up the new values when they update.

To change the logo, replace `res/et-tuning/logo-source.jpg` and run
`python3 res/et-tuning/make_icons.py` from the repo root.

## Releasing an update

1. Bump `version` in `Cargo.toml` and `flutter/pubspec.yaml` (for example 1.5.1 to 1.5.2).
   The version must always go up, or installed clients will not see the update.
2. Merge to `master`, then tag that commit and push the tag:
   `git tag v1.5.2 && git push origin v1.5.2`
3. The workflow builds the installers, signs the update metadata with the
   `UPDATE_ED25519_SEED` secret, and publishes a GitHub Release.
4. Installed clients check the latest release on startup and offer the update.
   With "auto update" on, they install it themselves when no session is active.

A release is published only after every file is uploaded, so clients never see a
half-finished release. Never delete or re-upload files on a published release; ship
a new version instead.

## Repository secrets

- `UPDATE_ED25519_SEED` (required to release): private key for update metadata.
  Create the pair with `python res/et-tuning/new_update_key.py` on your own computer,
  store the secret here, and put the public key bytes in `src/update_metadata.rs`.
  If the secret is lost, make a new pair and ship that build by hand to every machine.
- `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD` (optional): Authenticode
  certificate, base64-encoded .pfx. Unsigned builds work but show a SmartScreen warning.

## Merging upstream RustDesk

`git fetch https://github.com/rustdesk/rustdesk master && git merge FETCH_HEAD`.
Conflicts are usually limited to the files in the table above. After merging, keep
the version at least as high as the last ET Tuning release.

## License

RustDesk is AGPL-3.0, and so is this build. Anyone you give the client to is entitled
to its source code, which is this repository.
