//! The X: drive: East Texas Tuning's Cloud Storage bucket, mounted on the customer's PC
//! for as long as a technician holds a full control session on it.
//!
//! The technician's client holds a service account key and, every ten minutes, mints a
//! 15 minute token for the `xdrive-customer` account, which can read the bucket and add
//! new files under `Uploads/`. The token goes to the customer over the session.
//!
//! The customer's server process mounts the bucket with the bundled rclone and WinFsp on
//! the first token, hands rclone each renewed token through a loopback endpoint it polls
//! when its token runs out, and kills rclone when the last such session closes. rclone
//! runs in a job object that dies with this process, so a crash unmounts too, and a
//! token never outlives its 15 minutes.

use crate::{branding, client::Data};
use base::message_proto::{EtDriveToken, Message, Misc};
use hbb_common::{allow_err, bail, base64, log, serde_json, tokio, ResultType};
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

const DRIVE: &str = "X:";
const TOKEN_LIFETIME_SECS: i64 = 900;
const RENEW_EVERY: Duration = Duration::from_secs(600);
const TECH_KEY_FILE: &str = r"C:\ProgramData\ETTuning\xdrive-tech-key.json";
const PEER_FLAG: &str = "et_xdrive";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Tells the technician's client that this side mounts the X: drive, so a token is
/// never sent to a client that would not use it.
pub fn add_platform_additions(additions: &mut serde_json::Map<String, serde_json::Value>) {
    if !branding::XDRIVE_BUCKET.is_empty() {
        additions.insert(PEER_FLAG.into(), serde_json::json!(true));
    }
}

fn peer_supports(platform_additions: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(platform_additions)
        .ok()
        .and_then(|v| v.get(PEER_FLAG).and_then(|f| f.as_bool()))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------------------
// Technician side

/// Sends X: drive tokens for one session until dropped.
pub struct TokenSender(tokio::task::JoinHandle<()>);

impl Drop for TokenSender {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Starts sending tokens to a peer that mounts the X: drive, when this PC holds the
/// technician key. Must be called inside the Tokio runtime.
pub fn start_sending(
    peer_platform_additions: &str,
    sender: tokio::sync::mpsc::UnboundedSender<Data>,
) -> Option<TokenSender> {
    if branding::XDRIVE_BUCKET.is_empty()
        || !peer_supports(peer_platform_additions)
        || !std::path::Path::new(TECH_KEY_FILE).exists()
    {
        return None;
    }
    Some(TokenSender(tokio::spawn(async move {
        loop {
            match tokio::task::spawn_blocking(mint_customer_token).await {
                Ok(Ok((access_token, expires_at))) => {
                    let mut misc = Misc::new();
                    misc.set_et_drive_token(EtDriveToken {
                        access_token,
                        expires_at,
                        ..Default::default()
                    });
                    let mut msg = Message::new();
                    msg.set_misc(misc);
                    if sender.send(Data::Message(msg)).is_err() {
                        return;
                    }
                }
                Ok(Err(e)) => log::error!("X: drive token: {e}"),
                Err(e) => log::error!("X: drive token task: {e}"),
            }
            tokio::time::sleep(RENEW_EVERY).await;
        }
    })))
}

#[derive(serde::Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
    token_uri: String,
    project_id: String,
}

fn mint_customer_token() -> ResultType<(String, i64)> {
    let key: ServiceAccountKey = serde_json::from_slice(&std::fs::read(TECH_KEY_FILE)?)?;
    let tech_token = service_account_token(&key)?;
    let url = format!(
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{}@{}.iam.gserviceaccount.com:generateAccessToken",
        branding::XDRIVE_CUSTOMER_ACCOUNT,
        key.project_id
    );
    let resp = crate::hbbs_http::create_http_client_with_url_strict(&url)?
        .post(&url)
        .bearer_auth(tech_token)
        .json(&serde_json::json!({
            "scope": ["https://www.googleapis.com/auth/devstorage.read_write"],
            "lifetime": format!("{TOKEN_LIFETIME_SECS}s"),
        }))
        .send()?;
    let status = resp.status();
    let body: serde_json::Value = resp.json()?;
    let (Some(token), Some(expire_time)) =
        (body["accessToken"].as_str(), body["expireTime"].as_str())
    else {
        bail!("generateAccessToken failed: {status} {body}");
    };
    let expires_at = hbb_common::chrono::DateTime::parse_from_rfc3339(expire_time)?.timestamp();
    Ok((token.to_owned(), expires_at))
}

/// The technician account's own token, from a signed JWT assertion.
fn service_account_token(key: &ServiceAccountKey) -> ResultType<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let now = hbb_common::get_time() / 1000;
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({
        "iss": key.client_email,
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "aud": key.token_uri,
        "iat": now,
        "exp": now + 3600,
    }))?);
    let signing_input = format!("{header}.{claims}");
    let signature = rs256_sign(&key.private_key, signing_input.as_bytes())?;
    let assertion = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature));
    let resp = crate::hbbs_http::create_http_client_with_url_strict(&key.token_uri)?
        .post(&key.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()?;
    let status = resp.status();
    let body: serde_json::Value = resp.json()?;
    match body["access_token"].as_str() {
        Some(token) => Ok(token.to_owned()),
        None => bail!("service account sign-in failed: {status} {body}"),
    }
}

fn rs256_sign(private_key_pem: &str, data: &[u8]) -> ResultType<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::{rand::SystemRandom, signature};
    let der: String = private_key_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = STANDARD.decode(der.trim())?;
    let key_pair = signature::RsaKeyPair::from_pkcs8(&der)
        .map_err(|e| hbb_common::anyhow::anyhow!("bad service account key: {e}"))?;
    let mut sig = vec![0; key_pair.public().modulus_len()];
    key_pair
        .sign(
            &signature::RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            data,
            &mut sig,
        )
        .map_err(|_| hbb_common::anyhow::anyhow!("signing failed"))?;
    Ok(sig)
}

// ---------------------------------------------------------------------------------------
// Customer side

#[derive(Default)]
struct State {
    conns: HashSet<i32>,
    token: Option<(String, i64)>,
    mount: Option<Mount>,
    mounting: bool,
}

struct Mount {
    child: Child,
    job: JobHandle,
    stop_endpoint: Arc<AtomicBool>,
    endpoint_port: u16,
}

lazy_static::lazy_static! {
    static ref STATE: Mutex<State> = Default::default();
}

/// A token from the technician of connection `conn_id`. Only call it for an authorized
/// full control session; that connection must call `on_conn_closed` when it ends.
pub fn on_token(conn_id: i32, token: EtDriveToken) {
    if branding::XDRIVE_BUCKET.is_empty() || !is_plain_token(&token.access_token) {
        return;
    }
    let mut state = STATE.lock().unwrap();
    state.conns.insert(conn_id);
    state.token = Some((token.access_token, token.expires_at));
    let running = match state.mount.as_mut() {
        Some(m) => matches!(m.child.try_wait(), Ok(None)),
        None => false,
    };
    if running || state.mounting {
        return;
    }
    if let Some(m) = state.mount.take() {
        log::warn!("X: drive: rclone exited, mounting again");
        m.unmount();
    }
    state.mounting = true;
    std::thread::spawn(mount_thread);
}

/// Unmounts once the last session that sent a token has closed.
pub fn on_conn_closed(conn_id: i32) {
    let mut state = STATE.lock().unwrap();
    if !state.conns.remove(&conn_id) || !state.conns.is_empty() {
        return;
    }
    state.token = None;
    if let Some(m) = state.mount.take() {
        m.unmount();
        log::info!("X: drive unmounted");
    }
}

fn is_plain_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 4096
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
}

fn mount_thread() {
    let result = mount();
    let mut state = STATE.lock().unwrap();
    state.mounting = false;
    match result {
        Ok(m) if state.conns.is_empty() => m.unmount(),
        Ok(m) => {
            log::info!("X: drive mounted");
            state.mount = Some(m);
        }
        Err(e) => log::error!("X: drive mount failed: {e}"),
    }
}

fn xdrive_dir() -> ResultType<PathBuf> {
    match std::env::current_exe()?.parent() {
        Some(dir) => Ok(dir.join("xdrive")),
        None => bail!("no exe folder"),
    }
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("ettuning-xdrive")
}

fn mount() -> ResultType<Mount> {
    ensure_winfsp()?;
    let (token, expires_at) = match STATE.lock().unwrap().token.clone() {
        Some(t) => t,
        None => bail!("session closed"),
    };
    let cache = cache_dir();
    allow_err!(std::fs::remove_dir_all(&cache));
    std::fs::create_dir_all(&cache)?;
    let (endpoint_port, secret, stop_endpoint) = start_token_endpoint()?;
    let expiry = hbb_common::chrono::DateTime::from_timestamp(expires_at, 0)
        .unwrap_or_default()
        .to_rfc3339();
    // Options go in the environment rather than on the command line, which other
    // processes on the PC can read.
    let child = Command::new(xdrive_dir()?.join("rclone.exe"))
        .args([
            "mount",
            &format!(":gcs:{}", branding::XDRIVE_BUCKET),
            DRIVE,
            "--network-mode",
            "--volname",
            r"\\ETTuning\X",
            "-o",
            "FileSecurity=D:P(A;;FA;;;WD)",
            "--vfs-cache-mode",
            "writes",
            "--vfs-write-back",
            "0s",
            "--dir-cache-time",
            "30s",
            "--cache-dir",
        ])
        .arg(&cache)
        .env("RCLONE_CONFIG", cache.join("rclone.conf"))
        .env("RCLONE_GCS_BUCKET_POLICY_ONLY", "true")
        .env("RCLONE_GCS_NO_CHECK_BUCKET", "true")
        .env(
            "RCLONE_GCS_TOKEN_URL",
            format!("http://127.0.0.1:{endpoint_port}/{secret}"),
        )
        .env(
            "RCLONE_GCS_TOKEN",
            serde_json::json!({
                "access_token": token,
                "token_type": "Bearer",
                // rclone only asks the token URL for a new token when it has one of these.
                "refresh_token": "session",
                "expiry": expiry,
            })
            .to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            stop_token_endpoint(&stop_endpoint, endpoint_port);
            return Err(e.into());
        }
    };
    match JobHandle::kill_on_close(&child) {
        Ok(job) => Ok(Mount {
            child,
            job,
            stop_endpoint,
            endpoint_port,
        }),
        Err(e) => {
            allow_err!(child.kill());
            allow_err!(child.wait());
            stop_token_endpoint(&stop_endpoint, endpoint_port);
            Err(e)
        }
    }
}

impl Mount {
    fn unmount(mut self) {
        allow_err!(self.child.kill());
        allow_err!(self.child.wait());
        drop(self.job);
        stop_token_endpoint(&self.stop_endpoint, self.endpoint_port);
        allow_err!(std::fs::remove_dir_all(cache_dir()));
    }
}

/// A loopback endpoint in the shape of an OAuth token URL, which hands rclone the
/// latest token whenever its current one runs out.
fn start_token_endpoint() -> ResultType<(u16, String, Arc<AtomicBool>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let mut secret = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut secret)
        .map_err(|_| hbb_common::anyhow::anyhow!("no randomness"))?;
    let secret = hex::encode(secret);
    let stop = Arc::new(AtomicBool::new(false));
    let path = format!("/{secret} ");
    let stop_thread = stop.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop_thread.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(stream) = stream {
                allow_err!(serve_token(stream, &path));
            }
        }
    });
    Ok((port, secret, stop))
}

fn stop_token_endpoint(stop: &AtomicBool, port: u16) {
    stop.store(true, Ordering::SeqCst);
    // Wakes the blocked accept so the thread sees the flag.
    allow_err!(TcpStream::connect(("127.0.0.1", port)));
}

fn serve_token(mut stream: TcpStream, path: &str) -> ResultType<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let first_line = request.lines().next().unwrap_or_default();
    let token = STATE.lock().unwrap().token.clone();
    let (status, body) = match token {
        Some((token, expires_at))
            if first_line.starts_with("POST ") && first_line[5..].starts_with(path) =>
        {
            (
                "200 OK",
                serde_json::json!({
                    "access_token": token,
                    "token_type": "Bearer",
                    "expires_in": (expires_at - hbb_common::get_time() / 1000).max(0),
                })
                .to_string(),
            )
        }
        _ => ("400 Bad Request", r#"{"error":"invalid_grant"}"#.to_owned()),
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    Ok(())
}

const WINFSP_DLL: &str = r"C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll";

/// WinFsp is a file system driver, so it is installed on first use rather than by our
/// installer, which only has to carry its MSI.
fn ensure_winfsp() -> ResultType<()> {
    if std::path::Path::new(WINFSP_DLL).exists() {
        return Ok(());
    }
    log::info!("X: drive: installing WinFsp");
    let status = Command::new("msiexec")
        .arg("/i")
        .arg(xdrive_dir()?.join("winfsp.msi"))
        .args(["/qn", "/norestart"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    // 3010: installed, restart needed for an older version to go away.
    if !status.success() && status.code() != Some(3010) {
        bail!("WinFsp install failed: {status}");
    }
    Ok(())
}

struct JobHandle(windows::Win32::Foundation::HANDLE);

// A job handle is a kernel handle, usable from any thread.
unsafe impl Send for JobHandle {}

impl JobHandle {
    /// Puts `child` in a job that kills it when the job's last handle closes, which is
    /// also when this process exits for any reason.
    fn kill_on_close(child: &Child) -> ResultType<Self> {
        use windows::{
            core::PCWSTR,
            Win32::{Foundation::HANDLE, System::JobObjects::*},
        };
        unsafe {
            let job = JobHandle(CreateJobObjectW(None, PCWSTR::null())?);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )?;
            AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle()))?;
            Ok(job)
        }
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            allow_err!(windows::Win32::Foundation::CloseHandle(self.0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_goes_only_to_peers_that_mount() {
        assert!(peer_supports(r#"{"is_installed":true,"et_xdrive":true}"#));
        assert!(!peer_supports(r#"{"is_installed":true}"#));
        assert!(!peer_supports(""));
    }

    #[test]
    fn rejects_tokens_that_could_escape_their_field() {
        assert!(is_plain_token("ya29.c.b0AXv0zT-abc_123~+/="));
        assert!(!is_plain_token(""));
        assert!(!is_plain_token("abc\"def"));
        assert!(!is_plain_token("abc def"));
    }
}
