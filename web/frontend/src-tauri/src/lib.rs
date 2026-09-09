use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;
mod clipboard;

/// Note: orphan cleanup is handled by the Python sidecar on startup.
/// It only kills processes whose PIDs were tracked in .cockpit-child-pids,
/// never random Claude sessions running in other terminals.

const SERVER_ADDR: &str = "127.0.0.1:8420";

/// True only when the sidecar ANSWERS an HTTP request.
///
/// A bare `TcpStream::connect` was not enough: the listening socket accepts as
/// soon as it is bound, which is strictly earlier than uvicorn serving routes,
/// so "connected" could still mean "not yet answering".
///
/// Written against std rather than pulling in an HTTP crate for one probe.
/// `Host` carries the port; `origin_guard._split_host` strips it and accepts
/// 127.0.0.1 as loopback, and an ABSENT Origin is allowed on HTTP (it is the
/// same-origin shape) -- so this request satisfies both of the guard's clauses.
fn server_responds() -> bool {
    use std::io::{Read, Write};

    let Ok(mut stream) = std::net::TcpStream::connect(SERVER_ADDR) else {
        return false;
    };
    let t = std::time::Duration::from_millis(1500);
    let _ = stream.set_read_timeout(Some(t));
    let _ = stream.set_write_timeout(Some(t));

    // CRLF explicitly, and as escapes rather than a multi-line literal: HTTP
    // line endings are CRLF, and a Rust multi-line string would embed the
    // source file's own newlines (LF here) into the request instead.
    let req = b"GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:8420\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match stream.read(&mut buf) {
        Ok(n) => buf[..n].starts_with(b"HTTP/1.1 200"),
        Err(_) => false,
    }
}

/// A sidecar that stayed up this long is a HEALTHY run, not a crash loop
/// member. The restart budget counts CONSECUTIVE rapid failures; without this
/// reset the budget was for the LIFETIME of the app, so a server that ran fine
/// for six hours and then died was counted as the fourth crash and never
/// restarted. An external kill (Task Manager) burned a restart too.
const HEALTHY_RUN_SECS: u64 = 60;

/// Consecutive rapid failures tolerated before we stop and TELL the user.
const MAX_CONSECUTIVE_RESTARTS: u32 = 3;

/// Backoff between consecutive attempts: 2s, 4s, 8s. A flat retry into a port
/// that is still releasing is what the 2.1.7 bind-loop looked like.
fn backoff_for(attempts: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2u64 << attempts.min(2))
}

/// The give-up surface. In a packaged NSIS build nobody sees stderr, so a
/// stderr-only message left the panes on "waiting for connection" -- which is
/// the wording for a RECOVERABLE outage -- forever.
///
/// Non-blocking `show` with a callback, deliberately: a blocking dialog called
/// from inside the sidecar event task can deadlock the runtime. The window is
/// NOT closed and the app is NOT auto-quit; the user may need to copy text out
/// of a pane, so quitting stays their explicit choice.
fn report_give_up(app: &tauri::AppHandle, restart_count: Arc<AtomicU32>) {
    let app_handle = app.clone();
    app.dialog()
        .message(
            "The local Plexar Studio server stopped 3 times in a row and the app can no longer \
             reach it. Your sessions are not running.\n\nTry again restarts the server. Quit \
             closes Plexar Studio.",
        )
        .title("Plexar Studio server stopped")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Try again".to_string(),
            "Quit".to_string(),
        ))
        .show(move |try_again| {
            if try_again {
                restart_count.store(0, Ordering::SeqCst);
                eprintln!("[tauri] User chose Try again — resetting the restart budget and respawning the sidecar");
                spawn_sidecar(&app_handle, restart_count);
            } else {
                eprintln!("[tauri] User chose Quit after the sidecar gave up");
                app_handle.exit(0);
            }
        });
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    restart_count: Arc<AtomicU32>,
) {
    let shell = app.shell();
    let cmd = shell
        .sidecar("plexar-studio-server")
        .expect("failed to find plexar-studio-server sidecar")
        .env("NO_BROWSER", "1");

    let (mut rx, _child) = cmd.spawn().expect("failed to spawn plexar-studio-server");

    let app_handle = app.clone();
    let rc = restart_count.clone();
    let spawned_at = std::time::Instant::now();

    // Log sidecar output and handle crash recovery
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[server] terminated with {:?}", status);

                    if status.code == Some(3) {
                        eprintln!("[tauri] Sidecar exited 3: a running Plexar Studio already serves 127.0.0.1:8420 — attaching to it, not restarting");
                        break;
                    }

                    // A healthy run clears the budget BEFORE it is read, so the
                    // counter means "consecutive rapid failures", not "failures
                    // ever". Read the elapsed time from this spawn's own instant.
                    let uptime = spawned_at.elapsed();
                    if uptime.as_secs() >= HEALTHY_RUN_SECS {
                        rc.store(0, Ordering::SeqCst);
                        eprintln!(
                            "[tauri] Sidecar had run {:?} (>= {}s) — treating this as a fresh failure, restart budget reset",
                            uptime, HEALTHY_RUN_SECS
                        );
                    }

                    let attempts = rc.fetch_add(1, Ordering::SeqCst);
                    if attempts < MAX_CONSECUTIVE_RESTARTS {
                        let delay = backoff_for(attempts);
                        eprintln!(
                            "[tauri] Sidecar crashed — restarting in {:?} (attempt {}/{})...",
                            delay,
                            attempts + 1,
                            MAX_CONSECUTIVE_RESTARTS
                        );

                        // Orphan cleanup is handled by the Python sidecar on restart
                        // (only kills tracked cockpit-spawned processes, not user sessions)

                        // Wait before restart to let port free up. On the BLOCKING
                        // pool, not here: this task runs on tauri::async_runtime,
                        // and a std::thread::sleep in it parks an async worker for
                        // the whole backoff. Tauri re-exports no timer
                        // (async_runtime.rs:13-20) and a direct tokio dependency is
                        // not worth version-aligning for one sleep.
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            std::thread::sleep(delay)
                        })
                        .await;

                        // Respawn
                        spawn_sidecar(&app_handle, rc);
                    } else {
                        eprintln!(
                            "[tauri] Sidecar crashed 3 times — giving up. Restart the app."
                        );
                        report_give_up(&app_handle, rc);
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[server] error: {}", err);
                }
                _ => {}
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![clipboard::read_clipboard_image])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let restart_count = Arc::new(AtomicU32::new(0));

            // Spawn the sidecar and monitor it
            spawn_sidecar(&app.handle(), restart_count);

            // Wait for the server to answer BEFORE the window exists.
            //
            // THIS USED TO DO NOTHING, and the comment above it said the
            // opposite of what happened. Tauri builds every window whose
            // config has `create: true` in `app.rs::setup`, and only THEN
            // calls this hook -- window creation at app.rs:2374, this closure
            // at app.rs:2380. So the webview had already navigated to
            // `frontendDist` (http://localhost:8420) and already been refused
            // by the time the wait started. Measured: the sidecar needs ~2.0s
            // warm (longer cold, while Defender scans the 50MB onefile
            // extraction) and the webview navigates at ~0ms, so it lost the
            // race on essentially every launch. The user saw WebView2's own
            // "server could not be reached" page and had to hit Refresh.
            //
            // The recovery logic was in the worst possible place: App.jsx's
            // health-check polling lives INSIDE the page that failed to load,
            // so nothing ever retried -- the retrier never ran.
            //
            // The fix is ordering, not duration: `create: false` in
            // tauri.conf.json keeps Tauri's loop from building the window
            // (it filters on exactly that flag), and we build it below, after
            // the server answers.
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(30);
            let mut ready = false;
            while start.elapsed() <= timeout {
                if server_responds() {
                    ready = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if ready {
                println!("[tauri] Server ready in {:?}", start.elapsed());
            } else {
                // Build the window anyway rather than leaving no window at
                // all: a silent no-window launch is harder to diagnose than
                // the error page, and this is the same outcome as before the
                // fix -- not a new failure surface. 30s is 15x the measured
                // warm boot, so reaching it means something is actually wrong.
                eprintln!(
                    "[tauri] Server did not answer within {:?} -- opening the window anyway",
                    timeout
                );
            }

            // Now create the window. NOT filtered on `cfg.create`: that flag
            // is how we told Tauri's own loop to skip these, so filtering on
            // it here would skip them a second time and open nothing.
            let handle = app.handle().clone();
            let windows = handle.config().app.windows.clone();
            for cfg in &windows {
                tauri::WebviewWindowBuilder::from_config(&handle, cfg)?.build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
