use tauri::Manager;
use tauri_plugin_shell::ShellExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let shell = app.shell();

            // Spawn the cockpit-server sidecar with NO_BROWSER=1
            let cmd = shell
                .sidecar("cockpit-server")
                .expect("failed to find cockpit-server sidecar")
                .env("NO_BROWSER", "1");

            let (mut rx, _child) = cmd.spawn().expect("failed to spawn cockpit-server");

            // Log sidecar output in background
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
                            break;
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[server] error: {}", err);
                        }
                        _ => {}
                    }
                }
            });

            // Wait for the server to be ready before the webview loads
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(15);
            loop {
                if std::net::TcpStream::connect("127.0.0.1:8420").is_ok() {
                    println!("[tauri] Server is ready");
                    break;
                }
                if start.elapsed() > timeout {
                    eprintln!("[tauri] Warning: server did not start within 15s");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
