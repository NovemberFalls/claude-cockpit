#[cfg(not(debug_assertions))]
use tauri::Manager;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            #[cfg(not(debug_assertions))]
            {
                let shell = _app.shell();
                let (mut rx, _child) = shell
                    .sidecar("cockpit-server")
                    .expect("failed to find cockpit-server sidecar")
                    .spawn()
                    .expect("failed to spawn cockpit-server");

                // Log sidecar output in background
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                println!("[server stdout] {}", String::from_utf8_lossy(&line));
                            }
                            CommandEvent::Stderr(line) => {
                                eprintln!("[server stderr] {}", String::from_utf8_lossy(&line));
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
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
