// Tauri entrypoint for the self-contained InboxPro.app.
//
// Everything ships inside the .app bundle:
//   • Node.js binary (sidecar at Contents/MacOS/node-aarch64-apple-darwin)
//   • The prebuilt Next.js standalone server (Resources/server/)
//   • Prisma schema + migrations (Resources/prisma/)
//   • Empty seed DB with migrations pre-applied (Resources/prisma/dev.db.seed)
//
// On launch we copy the seed DB to a writable location the first time,
// spawn the bundled Node running the bundled server, wait for it to bind
// :3030, then show the window. On quit we kill the Node child.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

// The Node child we spawned. Stored globally so the quit handler can
// kill it on shutdown without juggling AppHandles.
static NODE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

// ── Paths ─────────────────────────────────────────────────────────────

// Writable storage for the user's SQLite DB + logs + future state.
// macOS convention: ~/Library/Application Support/<bundle-id>/
fn app_data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| {
        PathBuf::from(h)
            .join("Library")
            .join("Application Support")
            .join("com.jacobbrachna.inboxpro")
    })
}

fn writable_db_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("dev.db"))
}

// ── First-run DB seeding ──────────────────────────────────────────────

// Copy the bundled seed DB to the user's writable location on first
// launch. Idempotent: skips if dev.db already exists.
fn ensure_writable_db(app: &AppHandle) -> Result<PathBuf, String> {
    let target = writable_db_path().ok_or("no HOME directory")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {:?}: {}", parent, e))?;
    }
    if target.exists() {
        return Ok(target);
    }
    let seed = app
        .path()
        .resolve("resources/prisma/dev.db.seed", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("seed db missing from bundle: {}", e))?;
    std::fs::copy(&seed, &target).map_err(|e| format!("copy seed: {}", e))?;
    log::info!("seeded fresh dev.db at {:?}", target);
    Ok(target)
}

// ── Server lifecycle ──────────────────────────────────────────────────

fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(socket_addr) = addr.parse() {
        TcpStream::connect_timeout(&socket_addr, Duration::from_millis(300)).is_ok()
    } else {
        false
    }
}

// Boot the bundled Next.js server using the bundled Node binary. Stores
// the child handle so we can kill it on app exit.
fn start_server(app: &AppHandle, db_path: &PathBuf) -> Result<(), String> {
    let resolver = app.path();
    // Tauri ships externalBin entries in Contents/MacOS/ with the
    // target-triple suffix stripped. So "binaries/node" in tauri.conf.json
    // becomes Contents/MacOS/node at runtime. We resolve via the
    // current_exe() parent because BaseDirectory::Resource points at
    // Contents/Resources/, not Contents/MacOS/.
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let exe_dir = exe.parent().ok_or("current_exe has no parent")?;
    let node = exe_dir.join("node");
    if !node.exists() {
        return Err(format!("node sidecar missing at {:?}", node));
    }
    let server_dir = resolver
        .resolve("resources/server", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("server dir missing from bundle: {}", e))?;
    let server_js = server_dir.join("server.js");
    if !server_js.exists() {
        return Err(format!("server.js missing at {:?}", server_js));
    }

    log::info!("spawning {:?} {:?}", node, server_js);
    // Route Node's stdout+stderr to a known log file. Without this we
    // can't see why Node exits when bundled (it's silent from Finder
    // launches). Users can `tail -f /tmp/inboxpro-server.log` if
    // something looks wrong.
    let log_path = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Logs/InboxPro/server.log"))
        .unwrap_or_else(|| PathBuf::from("/tmp/inboxpro-server.log"));
    if let Some(parent) = log_path.parent() { let _ = std::fs::create_dir_all(parent); }
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log {:?}: {}", log_path, e))?;
    let stderr_log = log_file.try_clone().map_err(|e| format!("clone log: {}", e))?;
    let child = Command::new(&node)
        .arg(&server_js)
        .current_dir(&server_dir)
        .env("PORT", "3030")
        .env("HOSTNAME", "127.0.0.1")
        .env("DATABASE_URL", format!("file:{}", db_path.display()))
        .env("NODE_ENV", "production")
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|e| format!("spawn node: {}", e))?;
    log::info!("server pid {} → log at {:?}", child.id(), log_path);
    *NODE_CHILD.lock().unwrap() = Some(child);
    Ok(())
}

// Block until the server responds on :3030. Returns true on success.
fn wait_for_server(timeout_secs: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if port_open(3030) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

// Kill the Node child on app exit. Belt-and-braces: try the tracked
// handle first, then sweep anything still bound to :3030.
fn stop_server() {
    if let Some(mut child) = NODE_CHILD.lock().unwrap().take() {
        log::info!("killing node child pid {}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
    // Sweep — covers cases where the tracked handle got out of sync.
    if let Ok(out) = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP:3030", "-sTCP:LISTEN", "-t"])
        .output()
    {
        if let Ok(s) = String::from_utf8(out.stdout) {
            for line in s.lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    let _ = Command::new("/bin/kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                }
            }
        }
    }
}

// ── Auto-updater ──────────────────────────────────────────────────────

async fn check_for_updates(app: AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => { log::warn!("updater unavailable: {}", e); return; }
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => { log::info!("on latest"); return; }
        Err(e) => { log::warn!("update check failed: {}", e); return; }
    };
    log::info!("update available: v{}", update.version);
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
    if !confirmed { return; }
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        log::error!("update install failed: {}", e);
        return;
    }
    stop_server();
    app.restart();
}

// ── Boot ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Boot sequence on a background thread so we don't block the
            // main thread (which Tauri needs to run the event loop).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let db_path = match ensure_writable_db(&handle) {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("db seed failed: {}", e);
                        handle.exit(1);
                        return;
                    }
                };
                if let Err(e) = start_server(&handle, &db_path) {
                    log::error!("server start failed: {}", e);
                    handle.exit(1);
                    return;
                }
                if !wait_for_server(30) {
                    log::error!("server didn't bind :3030 within 30s");
                    handle.exit(1);
                    return;
                }
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.eval("window.location.replace('http://localhost:3030/');");
                    std::thread::sleep(Duration::from_millis(600));
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Update check, deferred so we don't fight the boot path.
                let update_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(5)))
                        .await.ok();
                    check_for_updates(update_handle).await;
                });
            });

            // Window close → kill server → exit. macOS apps normally
            // stay running after the last window closes; we want
            // quit-on-close because the headless server is useless
            // without the UI.
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
        match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_server(),
            _ => {}
        }
    });
}
