use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    for _ in 0..8 {
        let serial = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), serial));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建配置临时文件失败：{error}")),
        };
        if let Err(error) = file.write_all(contents).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(format!("写入配置文件失败：{error}"));
        }
        drop(file);
        let from = temporary
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let replaced = unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            let error = std::io::Error::last_os_error();
            let _ = fs::remove_file(&temporary);
            return Err(format!("替换配置文件失败：{error}"));
        }
        return Ok(());
    }
    Err("创建配置临时文件失败，请重试".into())
}
