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
2. Merge to `master`, then either push a tag (`git tag v1.5.2 && git push origin v1.5.2`)
   or open Actions > "ET Tuning Windows build" > Run workflow on `master` with
   "release" checked, which creates the tag itself.
3. The workflow builds the installers, signs the update metadata with the
   `UPDATE_ED25519_SEED` secret, and publishes a GitHub Release.
4. Installed clients check the latest release on startup and offer the update.
   With "auto update" on, they install it themselves when no session is active.

A release is published only after every file is uploaded, so clients never see a
half-finished release. Never delete or re-upload files on a published release; ship
a new version instead.

## X: drive

During a full control session, the customer's PC gets an X: drive backed by the Cloud
Storage bucket `ettuning-fileshare-files` (`XDRIVE_BUCKET` in `src/branding.rs`).
Customers can read everything and add new files under `Uploads\`; they cannot change
or delete anything. The drive unmounts when the session ends. The code is `src/xdrive.rs`.

- The technician PC needs the `xdrive-tech` key at
  `C:\ProgramData\ETTuning\xdrive-tech-key.json`. With it, the client gives each
  customer a 15 minute token, renewed every 10 minutes. Without it, no X: drive is offered.
- `res/et-tuning/xdrive-tech-setup.ps1` gives the technician PC its own permanent,
  read-write X: drive.
- Technician installer: on your own computer, run
  `powershell -ExecutionPolicy Bypass -File res\et-tuning\tech-installer\build.ps1 -KeyFile <key.json>`.
  It writes `ETTuning-Technician-Setup.cmd` next to the key, with the key inside. Run that
  file on the technician PC, signed in as the technician: it installs the client from the
  latest release if needed, puts the key in place and runs `xdrive-tech-setup.ps1`. The
  file is as secret as the key: keep it off customer PCs, out of this (public) repository
  and out of GitHub Actions. To change keys, create a new one in Google Cloud, rebuild,
  run it on each technician PC, then delete the old key.
- The installer carries `xdrive\rclone.exe` and `xdrive\winfsp.msi`. WinFsp is installed
  on the customer's PC the first time a drive is mounted, which needs the client to be
  installed (not run portable).
- Known limits: a file copied into `Uploads\` in the last moment before the session ends
  may not finish uploading. Writing outside `Uploads\` appears to work at first and then
  fails, because the drive is only read-only on the server side.

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
