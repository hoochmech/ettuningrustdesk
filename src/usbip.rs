//! USB over IP: a technician uses a USB device plugged into the customer's PC, such as an
//! RP1210 adapter, as if it were plugged into their own.
//!
//! The customer's server process shares the device with usbipd-win, installed from the
//! bundled MSI on first use, and stops sharing it when the session that shared it ends.
//! The technician's client tunnels the customer's usbipd port (3240) over a TCP tunneling
//! connection to the same peer and attaches the device with usbip-win2, installed from
//! the bundled setup on first use.

use crate::client::{Data, Interface};
use base::message_proto::{
    et_usb_request::Action, EtUsbDevice, EtUsbDevices, EtUsbRequest, Message, Misc,
};
use hbb_common::{bail, config::PeerConfig, log, serde_json, ResultType};
use std::{
    collections::{HashMap, HashSet},
    net::{SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

const USBIPD_EXE: &str = r"C:\Program Files\usbipd-win\usbipd.exe";
const USBIPD_MSI: &str = "usbipd-win.msi";
const USBIP_EXE: &str = r"C:\Program Files\USBip\usbip.exe";
const USBIP_SETUP: &str = "usbip-win2-setup.exe";
const USBIP_PORT: i32 = 3240;
const PEER_FLAG: &str = "et_usbip";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SHARE_TIMEOUT: Duration = Duration::from_secs(180);
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(60);

lazy_static::lazy_static! {
    // Customer side: the bus ids each connection shared.
    static ref SHARED: Mutex<HashMap<i32, HashSet<String>>> = Default::default();
    // Customer side: one usbipd call at a time, so two requests never both install.
    static ref BUSY: Mutex<()> = Default::default();
    // Technician side: per peer id.
    static ref TECH: Mutex<HashMap<String, TechState>> = Default::default();
}

#[derive(Default)]
struct TechState {
    devices: EtUsbDevices,
    status: String,
}

fn usbip_dir() -> ResultType<PathBuf> {
    match std::env::current_exe()?.parent() {
        Some(dir) => Ok(dir.join("usbip")),
        None => bail!("no exe folder"),
    }
}

/// usbipd bus ids look like `2-13`. Anything else never reaches a command line.
fn is_bus_id(s: &str) -> bool {
    s.len() <= 16
        && match s.split_once('-') {
            Some((a, b)) => {
                !a.is_empty()
                    && !b.is_empty()
                    && a.bytes().all(|c| c.is_ascii_digit())
                    && b.bytes().all(|c| c.is_ascii_digit())
            }
            None => false,
        }
}

// ---------------------------------------------------------------------------------------
// Customer side

/// Tells the technician's client that this side can share USB devices.
pub fn add_platform_additions(additions: &mut serde_json::Map<String, serde_json::Value>) {
    let bundled = usbip_dir()
        .map(|d| d.join(USBIPD_MSI).exists())
        .unwrap_or(false);
    if bundled || Path::new(USBIPD_EXE).exists() {
        additions.insert(PEER_FLAG.into(), serde_json::json!(true));
    }
}

/// A request from the technician of connection `conn_id`. Only call it for an authorized
/// full control session with tunneling allowed; that connection must call
/// `on_conn_closed` when it ends. `reply` gets the device list after the request.
pub fn on_request(conn_id: i32, req: EtUsbRequest, reply: impl FnOnce(Message) + Send + 'static) {
    std::thread::spawn(move || {
        let _busy = BUSY.lock().unwrap();
        let mut devices = EtUsbDevices::new();
        if let Err(e) = handle(conn_id, &req) {
            log::error!("USB: {e}");
            devices.error = e.to_string();
        }
        if devices.error.is_empty() || Path::new(USBIPD_EXE).exists() {
            match usbipd(&["state"]).and_then(|s| parse_state(&s)) {
                Ok(d) => devices.devices = d,
                Err(e) => {
                    log::error!("USB list: {e}");
                    if devices.error.is_empty() {
                        devices.error = e.to_string();
                    }
                }
            }
        }
        let mut misc = Misc::new();
        misc.set_et_usb_devices(devices);
        let mut msg = Message::new();
        msg.set_misc(misc);
        reply(msg);
    });
}

fn handle(conn_id: i32, req: &EtUsbRequest) -> ResultType<()> {
    ensure_usbipd()?;
    let bus_id = &req.bus_id;
    match req.action.enum_value() {
        Ok(Action::List) => {}
        Ok(Action::Share) => {
            if !is_bus_id(bus_id) {
                bail!("invalid bus id");
            }
            usbipd(&["bind", "--busid", bus_id])?;
            log::info!("USB: shared {bus_id} for connection {conn_id}");
            SHARED
                .lock()
                .unwrap()
                .entry(conn_id)
                .or_default()
                .insert(bus_id.clone());
        }
        Ok(Action::Unshare) => {
            let ours = SHARED
                .lock()
                .unwrap()
                .get_mut(&conn_id)
                .map(|s| s.remove(bus_id))
                .unwrap_or(false);
            if !ours {
                bail!("this session did not share {bus_id}");
            }
            usbipd(&["unbind", "--busid", bus_id])?;
            log::info!("USB: stopped sharing {bus_id} for connection {conn_id}");
        }
        Err(v) => bail!("unknown USB action {v}"),
    }
    Ok(())
}

/// Stops sharing what this connection shared, which also detaches it from the technician.
pub fn on_conn_closed(conn_id: i32) {
    let ids = match SHARED.lock().unwrap().remove(&conn_id) {
        Some(ids) if !ids.is_empty() => ids,
        _ => return,
    };
    std::thread::spawn(move || {
        let _busy = BUSY.lock().unwrap();
        for id in ids {
            match usbipd(&["unbind", "--busid", &id]) {
                Ok(_) => log::info!("USB: stopped sharing {id}, session ended"),
                Err(e) => log::error!("USB: unbind {id}: {e}"),
            }
        }
    });
}

fn usbipd(args: &[&str]) -> ResultType<String> {
    let out = Command::new(USBIPD_EXE)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!(
            "usbipd {} failed ({}): {} {}",
            args.join(" "),
            out.status,
            stderr.trim(),
            stdout.trim()
        );
    }
    Ok(stdout)
}

/// usbipd-win installs a USB filter driver and a service, so it is installed on first use
/// rather than by our installer, which only has to carry its MSI. This runs in the
/// server process, which has the rights to install silently.
fn ensure_usbipd() -> ResultType<()> {
    if Path::new(USBIPD_EXE).exists() {
        return Ok(());
    }
    log::info!("USB: installing usbipd-win");
    let status = Command::new("msiexec")
        .arg("/i")
        .arg(usbip_dir()?.join(USBIPD_MSI))
        .args(["/qn", "/norestart"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    // 3010: installed, restart needed for an older version to go away.
    if !status.success() && status.code() != Some(3010) {
        bail!("usbipd-win install failed: {status}");
    }
    if !Path::new(USBIPD_EXE).exists() {
        bail!("usbipd-win install did not create {USBIPD_EXE}");
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct UsbipdState {
    #[serde(rename = "Devices", default)]
    devices: Vec<UsbipdDevice>,
}

#[derive(serde::Deserialize)]
struct UsbipdDevice {
    #[serde(rename = "BusId")]
    bus_id: Option<String>,
    #[serde(rename = "Description", default)]
    description: String,
    #[serde(rename = "PersistedGuid")]
    persisted_guid: Option<String>,
    #[serde(rename = "ClientIPAddress")]
    client_ip_address: Option<String>,
}

/// Parses `usbipd state`, keeping only devices plugged in now.
fn parse_state(json: &str) -> ResultType<Vec<EtUsbDevice>> {
    let state: UsbipdState = serde_json::from_str(json)?;
    Ok(state
        .devices
        .into_iter()
        .filter_map(|d| {
            Some(EtUsbDevice {
                bus_id: d.bus_id?,
                description: d.description,
                shared: d.persisted_guid.is_some(),
                attached: d.client_ip_address.is_some(),
                ..Default::default()
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------------------
// Technician side

/// Sends `action` ("list", "share" or "unshare") for `bus_id` to the peer.
pub fn send_request<T: Interface>(session: &T, action: &str, bus_id: String) {
    let action = match action {
        "list" => Action::List,
        "share" => Action::Share,
        "unshare" => Action::Unshare,
        _ => return,
    };
    let mut misc = Misc::new();
    misc.set_et_usb_request(EtUsbRequest {
        action: action.into(),
        bus_id,
        ..Default::default()
    });
    let mut msg = Message::new();
    msg.set_misc(misc);
    session.send(Data::Message(msg));
}

pub fn on_devices(peer_id: &str, devices: EtUsbDevices) {
    TECH.lock()
        .unwrap()
        .entry(peer_id.to_owned())
        .or_default()
        .devices = devices;
}

/// The peer's last device list, its error and this side's attach status, as JSON.
pub fn state_json(peer_id: &str) -> String {
    let tech = TECH.lock().unwrap();
    let Some(s) = tech.get(peer_id) else {
        return "{}".to_owned();
    };
    let devices: Vec<_> = s
        .devices
        .devices
        .iter()
        .map(|d| {
            serde_json::json!({
                "bus_id": d.bus_id,
                "description": d.description,
                "shared": d.shared,
                "attached": d.attached,
            })
        })
        .collect();
    serde_json::json!({
        "devices": devices,
        "error": s.devices.error,
        "status": s.status,
    })
    .to_string()
}

fn set_status(peer_id: &str, status: String) {
    log::info!("USB {peer_id}: {status}");
    TECH.lock()
        .unwrap()
        .entry(peer_id.to_owned())
        .or_default()
        .status = status;
}

/// Saves the usbipd tunnel in the peer's port forwards, so the TCP tunneling connection
/// the caller opens next starts it, then attaches `bus_id` once the peer shares it.
/// Call it before sending the share request.
pub fn attach(peer_id: String, bus_id: String) {
    if !is_bus_id(&bus_id) {
        return;
    }
    let mut config = PeerConfig::load(&peer_id);
    if !config.port_forwards.iter().any(|x| x.0 == USBIP_PORT) {
        config
            .port_forwards
            .push((USBIP_PORT, "127.0.0.1".to_owned(), USBIP_PORT));
        config.store(&peer_id);
    }
    TECH.lock()
        .unwrap()
        .entry(peer_id.clone())
        .or_default()
        .devices
        .error
        .clear();
    set_status(&peer_id, format!("Connecting {bus_id}..."));
    std::thread::spawn(move || {
        if let Err(e) = attach_thread(&peer_id, &bus_id) {
            set_status(&peer_id, format!("Failed: {e}"));
        }
    });
}

fn attach_thread(peer_id: &str, bus_id: &str) -> ResultType<()> {
    if Path::new(USBIPD_EXE).exists() {
        bail!("usbipd-win is installed on this PC and takes port 3240; uninstall it here (it is only needed on the customer's PC)");
    }
    ensure_usbip_win2(peer_id)?;
    set_status(
        peer_id,
        "Waiting for the customer's PC to share the device...".into(),
    );
    wait_for(
        SHARE_TIMEOUT,
        "the customer's PC did not share the device",
        || {
            let tech = TECH.lock().unwrap();
            let devices = match tech.get(peer_id) {
                Some(s) => &s.devices,
                None => return Ok(false),
            };
            if !devices.error.is_empty() {
                bail!("customer's PC: {}", devices.error);
            }
            Ok(devices
                .devices
                .iter()
                .any(|d| d.bus_id == bus_id && d.shared))
        },
    )?;
    set_status(peer_id, "Waiting for the TCP tunnel...".into());
    let addr = SocketAddr::from(([127, 0, 0, 1], USBIP_PORT as u16));
    wait_for(
        TUNNEL_TIMEOUT,
        "the TCP tunnel did not open; close any TCP tunneling window for this PC and try again",
        || Ok(TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok()),
    )?;
    set_status(peer_id, format!("Attaching {bus_id}..."));
    let out = Command::new(USBIP_EXE)
        .args(["attach", "-r", "127.0.0.1", "-b", bus_id])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&out.stdout).trim(),
        String::from_utf8_lossy(&out.stderr).trim()
    );
    if !out.status.success() {
        bail!("usbip attach ({}): {}", out.status, text.trim());
    }
    log::info!("USB {peer_id}: usbip attach: {}", text.trim());
    set_status(
        peer_id,
        format!(
            "{bus_id} is attached to this PC. Keep the TCP tunneling window open while you use it."
        ),
    );
    Ok(())
}

fn wait_for(
    timeout: Duration,
    what: &str,
    mut done: impl FnMut() -> ResultType<bool>,
) -> ResultType<()> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if done()? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!("{what}");
}

/// usbip-win2 installs a virtual USB host driver, so it needs an administrator: the
/// technician gets a Windows prompt the first time.
fn ensure_usbip_win2(peer_id: &str) -> ResultType<()> {
    if Path::new(USBIP_EXE).exists() {
        return Ok(());
    }
    set_status(
        peer_id,
        "Installing USB/IP on this PC. Accept the Windows prompt.".into(),
    );
    let setup = usbip_dir()?.join(USBIP_SETUP);
    if !setup.exists() {
        bail!("{} is missing", setup.display());
    }
    let setup = setup.to_string_lossy().replace('\'', "''");
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
        ])
        .arg(format!(
            "Start-Process -FilePath '{setup}' -ArgumentList '/SILENT /SUPPRESSMSGBOXES /NORESTART' -Verb RunAs -Wait"
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if !status.success() || !Path::new(USBIP_EXE).exists() {
        bail!("USB/IP was not installed ({status})");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_bus_ids_reach_usbipd() {
        assert!(is_bus_id("2-13"));
        assert!(!is_bus_id("2-"));
        assert!(!is_bus_id("--all"));
        assert!(!is_bus_id("2-1 --force"));
    }

    #[test]
    fn lists_plugged_in_devices_from_usbipd_state() {
        let json = r#"{"Devices":[
            {"BusId":"2-3","ClientIPAddress":null,"Description":"NEXIQ USB-Link 3","InstanceId":"USB\\VID_0A3C&PID_0101\\1","IsForced":false,"PersistedGuid":"6f4a7c1e-0000-0000-0000-000000000000","StubInstanceId":null},
            {"BusId":"1-7","ClientIPAddress":"127.0.0.1","Description":"USB Serial Converter","InstanceId":"x","IsForced":false,"PersistedGuid":"7f4a7c1e-0000-0000-0000-000000000000","StubInstanceId":"y"},
            {"BusId":null,"ClientIPAddress":null,"Description":"Unplugged","InstanceId":"z","IsForced":false,"PersistedGuid":"8f4a7c1e-0000-0000-0000-000000000000","StubInstanceId":null},
            {"BusId":"1-2","ClientIPAddress":null,"Description":"Keyboard","InstanceId":"k","IsForced":false,"PersistedGuid":null,"StubInstanceId":null}
        ]}"#;
        let d = parse_state(json).unwrap();
        assert_eq!(d.len(), 3);
        assert_eq!(
            (d[0].bus_id.as_str(), d[0].shared, d[0].attached),
            ("2-3", true, false)
        );
        assert!(d[1].attached);
        assert_eq!(
            (d[2].description.as_str(), d[2].shared),
            ("Keyboard", false)
        );
    }
}
