// Tauri entrypoint. Boots the desktop window pointing at the local
// Next.js server, which we auto-launch via scripts/launch-server.sh.
// Window stays hidden until the server is reachable on :3030.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};

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
    // Start the server BEFORE Tauri creates the window so the window has
    // a live URL to load. start_server() is non-blocking (the script
    // detaches), then wait_for_server() polls until 3030 responds.
    start_server();
    wait_for_server();

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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Reveal the main window after a brief moment so the user
            // doesn't see a blank flash while Next.js renders the first
            // page. visible:false in config, then we show here.
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(800));
                    let _ = w.show();
                    let _ = w.set_focus();
                });
                // Window close → kill the Next.js server AND exit the
                // app entirely. On macOS apps typically stay running
                // after the last window closes, but for InboxPro we
                // want quit-on-close — there's no reason to keep a
                // headless server alive when the UI is gone.
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
