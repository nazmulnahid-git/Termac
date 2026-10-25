// Small persistence helpers: atomic writes (tmp + rename) and debounced saves.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn read_json<T: serde::de::DeserializeOwned>(file: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

pub fn write_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, file)
}

#[derive(Default)]
struct Pending {
    data: Option<String>,
    scheduled: bool,
}

// Coalesces frequent saves into one write per `delay`. `flush_sync` is for quit.
pub struct DebouncedWriter {
    file: PathBuf,
    delay: Duration,
    pending: Arc<Mutex<Pending>>,
    io: Arc<Mutex<()>>,
}

impl DebouncedWriter {
    pub fn new(file: PathBuf, delay_ms: u64) -> Self {
        DebouncedWriter { file, delay: Duration::from_millis(delay_ms), pending: Default::default(), io: Default::default() }
    }

    pub fn save(&self, data: String) {
        let mut p = self.pending.lock().unwrap();
        p.data = Some(data);
        if p.scheduled {
            return;
        }
        p.scheduled = true;
        let (pending, io, file, delay) = (self.pending.clone(), self.io.clone(), self.file.clone(), self.delay);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let _io = io.lock().unwrap();
            let data = {
                let mut p = pending.lock().unwrap();
                p.scheduled = false;
                p.data.take()
            };
            if let Some(data) = data {
                if let Err(e) = write_atomic(&file, data.as_bytes()) {
                    eprintln!("save failed {}: {e}", file.display());
                }
            }
        });
    }

    pub fn flush_sync(&self) {
        let _io = self.io.lock().unwrap();
        if let Some(data) = self.pending.lock().unwrap().data.take() {
            let _ = write_atomic(&self.file, data.as_bytes());
        }
    }
}
