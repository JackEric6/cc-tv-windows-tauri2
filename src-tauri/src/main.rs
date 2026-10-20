#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--complete-update") {
        let installer = std::env::args_os().nth(2).map(std::path::PathBuf::from);
        if let Some(installer) = installer {
            std::process::exit(congcong_tv_windows_tauri2_lib::run_update_helper(installer));
        }
        std::process::exit(2);
    }
    congcong_tv_windows_tauri2_lib::run()
}
