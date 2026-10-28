//! East Texas Tuning build identity.
//!
//! Everything that makes this build "ET Tuning Remote Client" instead of stock
//! RustDesk is pinned here, so an upstream merge only has to keep this module and
//! the few call sites that read it.

use base::config::keys;
use hbb_common::config;

/// Internal app id. It names the exe, the Windows service, the install folder, the
/// config folder and the URI scheme, so it must stay alphanumeric (no spaces).
/// Changing it after release makes installed clients look like a different app.
pub const APP_NAME: &str = "ETTuningRemote";

/// The name people see in the UI.
pub const DISPLAY_NAME: &str = "ET Tuning Remote Client";

pub const COMPANY_NAME: &str = "East Texas Tuning";

pub const ID_SERVER: &str = "35.202.21.179";
pub const RELAY_SERVER: &str = "35.202.21.179";
pub const SERVER_PUB_KEY: &str = "vt/KXmMLybFz/PZYJcMkGWXX95jNRr5oA44CPQGTB+c=";
/// Where each PC reports its sessions opening and closing (see `session-tracker/`).
pub const API_SERVER: &str = "https://rustdesk-api-482222-sessions.web.app";

/// GitHub repository whose releases this client updates from.
pub const UPDATE_REPO_OWNER: &str = "hoochmech";
pub const UPDATE_REPO_NAME: &str = "ettuningrustdesk";

/// Cloud Storage bucket behind the X: drive (see `src/xdrive.rs`). Empty turns it off.
pub const XDRIVE_BUCKET: &str = "ettuning-fileshare-files";
/// Service account whose short-lived tokens customers mount the X: drive with.
pub const XDRIVE_CUSTOMER_ACCOUNT: &str = "xdrive-customer";

pub fn releases_url() -> String {
    format!("https://github.com/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/releases")
}

pub fn latest_release_api_url() -> String {
    format!("https://api.github.com/repos/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/releases/latest")
}

/// Applies the app name, locks the server settings and sets our install defaults,
/// before anything reads them.
pub fn apply() {
    *config::APP_NAME.write().unwrap() = APP_NAME.to_owned();
    let mut overwrite = config::OVERWRITE_SETTINGS.write().unwrap();
    for (k, v) in [
        (keys::OPTION_CUSTOM_RENDEZVOUS_SERVER, ID_SERVER),
        (keys::OPTION_RELAY_SERVER, RELAY_SERVER),
        (keys::OPTION_KEY, SERVER_PUB_KEY),
        (keys::OPTION_API_SERVER, API_SERVER),
    ] {
        overwrite.insert(k.to_owned(), v.to_owned());
    }
    drop(overwrite);
    // Defaults, not overrides: the PC's owner can still turn these off in settings.
    config::DEFAULT_SETTINGS.write().unwrap().insert(
        keys::OPTION_ALLOW_REMOTE_CONFIG_MODIFICATION.to_owned(),
        "Y".to_owned(),
    );
}
