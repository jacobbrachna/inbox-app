// Tauri entrypoint. Boots the desktop window pointing at the local
// Next.js server, which we auto-launch via scripts/launch-server.sh.
// On a fresh Mac with no ~/Documents/inbox-app, we run scripts/bootstrap.sh
// (bundled inside the .app) in a Terminal window first to clone the repo
// and install everything, then proceed with the normal launch.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

// Resolve `~/Documents/inbox-app` — where the installer places the app
// and where launch-server.sh lives. Falls back to cwd in dev when the
// Tauri binary is launched from inside the repo.
fn install_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home).join("Documents").join("inbox-app");
        if p.join("scripts/launch-server.sh").exists() {
            return p;
        }
    }
    std::env::current_dir().unwrap_or_default()
}

// Canonical "is the install ready" check — separated from install_dir()
// so we can detect first-run state without committing to a path.
fn install_ready() -> bool {
    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home).join("Documents").join("inbox-app");
        return p.join("scripts/launch-server.sh").exists() && p.join("node_modules").exists();
    }
    false
}

// Spawn bootstrap.sh (bundled inside the .app as a resource) in a real
// Terminal window so the user sees install progress. Returns after the
// script finishes (signaled by `ok` written to the status file) or
// errors. Returns true on success.
fn run_bootstrap(app: &tauri::AppHandle) -> bool {
    let resolver = app.path();
    // Tauri 2 puts bundle resources under the Resources dir of the .app.
    let script_path = match resolver.resolve("scripts/bootstrap.sh", tauri::path::BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            log::error!("bootstrap script resource not found: {}", e);
            return false;
        }
    };

    // Reset status file so we know it's a fresh run.
    let status_path = "/tmp/inboxpro-bootstrap-status";
    let _ = std::fs::remove_file(status_path);

    log::info!("opening Terminal to run {:?}", script_path);
    let osa_cmd = format!(
        "tell application \"Terminal\" to activate\n\
         tell application \"Terminal\" to do script \"bash '{}'; exit\"",
        script_path.display()
    );
    let _ = Command::new("/usr/bin/osascript")
        .args(["-e", &osa_cmd])
        .spawn();

    // Poll for completion. bootstrap.sh writes "ok" or "fail" to the
    // status file. Hard ceiling of 30 min just in case Homebrew + Node
    // are being installed from scratch on a slow connection.
    let deadline = std::time::Instant::now() + Duration::from_secs(30 * 60);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(1));
        if let Ok(s) = std::fs::read_to_string(status_path) {
            let v = s.trim();
            if v == "ok" {
                return true;
            }
            if v == "fail" {
                log::error!("bootstrap reported failure");
                return false;
            }
        }
        // Also accept "install_ready()" returning true — bootstrap may
        // succeed faster than its final status write, or the user may
        // have run it manually and we can pick up the state.
        if install_ready() {
            return true;
        }
    }
    log::error!("bootstrap timed out");
    false
}

fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(socket_addr) = addr.parse() {
        TcpStream::connect_timeout(&socket_addr, Duration::from_millis(300)).is_ok()
    } else {
        false
    }
}

// Apps launched from Finder inherit a minimal PATH that doesn't include
// /opt/homebrew/bin or nvm paths. Shell out via `bash -lc` so the user's
// shell init sets node/npm correctly.
fn start_server() {
    let dir = install_dir();
    let script = dir.join("scripts/launch-server.sh");
    if !script.exists() {
        log::warn!("launch-server.sh not found at {:?} — assuming user runs server manually", script);
        return;
    }
    let cmd = format!("cd {:?} && bash {:?}", dir, script);
    log::info!("starting server: {}", cmd);
    let _ = Command::new("/bin/bash")
        .args(["-lc", &cmd])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

// Block until the server responds, up to 30s. Returns true on success.
fn wait_for_server() -> bool {
    for _ in 0..60 {
        if port_open(3030) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

// Check the configured updater endpoint for a new version. If one is
// available, prompt the user; on Yes, download + install + restart.
// Best-effort: any error is logged and ignored so a flaky network never
// breaks app launch. Run in a background task a few seconds after boot.
async fn check_for_updates(app: AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => { log::warn!("updater unavailable: {}", e); return; }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => { log::info!("already on latest version"); return; }
        Err(e) => { log::warn!("update check failed: {}", e); return; }
    };
    log::info!("update available: v{}", update.version);

    // show_blocking() returns the user's choice synchronously — much
    // cleaner than the callback variant when we're already in an async task.
    let confirmed = app
        .dialog()
        .message(format!("InboxPro {} is ready to install.", update.version))
        .kind(MessageDialogKind::Info)
        .title("Update available")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "Install and Restart".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !confirmed {
        log::info!("user declined update");
        return;
    }
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        log::error!("update install failed: {}", e);
        return;
    }
    log::info!("update installed — restarting");
    stop_server();
    app.restart();
}

// Kills the Next.js child process on app exit. npm spawns `next-server`
// as a detached child, so killing the npm parent alone leaves the real
// server orphaned on :3030. We pkill the parent PID's descendants, then
// kill anything still bound to the port as a final sweep.
fn stop_server() {
    let pidfile = "/tmp/inboxpro-prod.pid";
    if let Ok(s) = std::fs::read_to_string(pidfile) {
        if let Ok(pid) = s.trim().parse::<i32>() {
            log::info!("stopping server pid {} (and descendants)", pid);
            // pkill -P: matches children of `pid` and signals them
            let _ = Command::new("/usr/bin/pkill").args(["-TERM", "-P", &pid.to_string()]).status();
            let _ = Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status();
        }
        let _ = std::fs::remove_file(pidfile);
    }
    // Belt-and-braces: kill anything still holding :3030 — covers cases
    // where pkill missed a grandchild or the pidfile was stale.
    if let Ok(out) = Command::new("/usr/sbin/lsof").args(["-nP", "-iTCP:3030", "-sTCP:LISTEN", "-t"]).output() {
        if let Ok(s) = String::from_utf8(out.stdout) {
            for line in s.lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    log::info!("port-sweep kill pid {}", pid);
                    let _ = Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status();
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // We need an AppHandle to resolve the bundled bootstrap.sh resource,
    // so we build the Tauri app first (without showing windows) and only
    // then do the install-ready check + server startup. The main window
    // is `visible: false` in config — it stays hidden until we show it
    // explicitly below.
    let app = tauri::Builder::default()
        // Single-instance: if the user double-clicks InboxPro while a
        // copy is already running, the second launch sends a signal to
        // the first (which raises its window) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Auto-updater: pulls latest.json from the GitHub Releases
        // endpoint, verifies the bundle signature against the embedded
        // pubkey, downloads and applies on user consent.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Dialog plugin: backs the update-available confirm prompt.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // First-run check: if ~/Documents/inbox-app isn't set up,
            // spawn the bootstrap script in Terminal. Block here on a
            // background thread so we don't freeze the UI thread, then
            // continue with server startup once it's done.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if !install_ready() {
                    log::info!("install not found — running bootstrap");
                    if !run_bootstrap(&handle) {
                        log::error!("bootstrap failed — exiting");
                        handle.exit(1);
                        return;
                    }
                }
                start_server();
                wait_for_server();
                if let Some(window) = handle.get_webview_window("main") {
                    // Navigate now that the server is ready (the window
                    // was created pointing at :3030 but may have hit
                    // ERR_CONNECTION_REFUSED if Tauri was faster than us).
                    let _ = window.eval("window.location.replace('http://localhost:3030/');");
                    // Tiny grace period for the first paint, then show.
                    std::thread::sleep(Duration::from_millis(600));
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Check for updates a few seconds after the UI is visible
                // so we don't compete with the boot path for network or
                // CPU. Best-effort — failures are silently logged.
                let update_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(5)))
                        .await.ok();
                    check_for_updates(update_handle).await;
                });
            });

            // Wire window close → server kill → app exit. Done outside
            // the bootstrap thread because window events fire on the
            // main thread regardless of when we register.
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        stop_server();
                        handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|_app, event| {
        // Belt-and-braces shutdown: ExitRequested fires before exit,
        // Exit fires AFTER. Either way we call stop_server again so a
        // server process can't outlive the app even if the window-close
        // handler missed it.
        match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_server(),
            _ => {}
        }
    });
}
