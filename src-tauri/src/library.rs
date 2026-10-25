// Archived sessions: a small JSON index plus one ANSI scrollback file per session.
// Full-text search reads scrollback lazily and keeps a bounded cache of stripped text.
use crate::store::{read_json, DebouncedWriter};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

static ANSI: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]").unwrap());
const CACHE_LIMIT: usize = 24 * 1024 * 1024;
const DAY_MS: f64 = 86_400_000.0;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

pub fn safe_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    q: Option<String>,
    space_id: Option<String>,
    cwd: Option<String>,
    host: Option<String>,
    status: Option<String>,
    since_days: Option<f64>,
}

pub struct Library {
    dir: PathBuf,
    entries: Vec<Map<String, Value>>,
    writer: DebouncedWriter,
    cache: HashMap<String, String>,
    order: VecDeque<String>,
    cache_size: usize,
}

fn opt(o: &Option<String>) -> Option<&str> {
    o.as_deref().filter(|s| !s.is_empty())
}

fn field<'a>(e: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str)
}

impl Library {
    pub fn new(dir: PathBuf) -> Self {
        let index = dir.join("index.json");
        Library {
            entries: read_json(&index).unwrap_or_default(),
            writer: DebouncedWriter::new(index, 300),
            dir,
            cache: HashMap::new(),
            order: VecDeque::new(),
            cache_size: 0,
        }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.ans", safe_id(id)))
    }

    fn save_index(&self) {
        self.writer.save(serde_json::to_string(&self.entries).unwrap_or_else(|_| "[]".into()));
    }

    pub fn add(&mut self, mut entry: Map<String, Value>, ansi: String) -> Value {
        let id = field(&entry, "id").unwrap_or_default().to_string();
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(self.file(&id), &ansi);
        let returned = Value::Object(entry.clone());
        self.entries.retain(|e| field(e, "id") != Some(&id));
        entry.insert("bytes".into(), json!(ansi.encode_utf16().count()));
        self.entries.insert(0, entry);
        self.drop_cache(&id);
        self.save_index();
        returned
    }

    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|e| field(e, "id") != Some(id));
        self.save_index();
        self.drop_cache(id);
        let _ = std::fs::remove_file(self.file(id));
    }

    pub fn content(&self, id: &str) -> String {
        std::fs::read(self.file(id)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
    }

    pub fn prune(&mut self, days: f64) {
        if days <= 0.0 {
            return;
        }
        let cutoff = now_ms() - days * DAY_MS;
        let old: Vec<String> = self
            .entries
            .iter()
            .filter(|e| e.get("endedAt").and_then(Value::as_f64).unwrap_or(0.0) < cutoff)
            .filter_map(|e| field(e, "id").map(str::to_string))
            .collect();
        for id in old {
            self.remove(&id);
        }
    }

    fn drop_cache(&mut self, id: &str) {
        if let Some(t) = self.cache.remove(id) {
            self.cache_size -= t.len();
            self.order.retain(|k| k != id);
        }
    }

    fn text(&mut self, id: &str) -> &str {
        if self.cache.contains_key(id) {
            self.order.retain(|k| k != id);
        } else {
            let t = ANSI.replace_all(&self.content(id), "").to_lowercase();
            self.cache_size += t.len();
            self.cache.insert(id.to_string(), t);
            while self.cache_size > CACHE_LIMIT {
                let Some(old) = self.order.pop_front() else { break };
                if let Some(v) = self.cache.remove(&old) {
                    self.cache_size -= v.len();
                }
            }
        }
        self.order.push_back(id.to_string());
        &self.cache[id]
    }

    pub fn search(&mut self, query: Query) -> Value {
        let q = query.q.unwrap_or_default().trim().to_lowercase();
        let since = query.since_days.filter(|d| *d > 0.0).map_or(0.0, |d| now_ms() - d * DAY_MS);
        let mut out = Vec::new();
        for i in 0..self.entries.len() {
            let e = &self.entries[i];
            if opt(&query.space_id).is_some_and(|v| field(e, "spaceId") != Some(v))
                || opt(&query.cwd).is_some_and(|v| field(e, "cwd") != Some(v))
                || opt(&query.host).is_some_and(|v| field(e, "host").filter(|h| !h.is_empty()).unwrap_or("local") != v)
                || opt(&query.status).is_some_and(|v| field(e, "status") != Some(v))
                || (since > 0.0 && e.get("endedAt").and_then(Value::as_f64).unwrap_or(0.0) < since)
            {
                continue;
            }
            if q.is_empty() {
                out.push(Value::Object(e.clone()));
            } else {
                let has = |k: &str| field(e, k).is_some_and(|s| s.to_lowercase().contains(&q));
                let in_commands = e.get("commands").and_then(Value::as_array).is_some_and(|cs| {
                    cs.iter().any(|c| c.get("cmd").and_then(Value::as_str).is_some_and(|s| s.to_lowercase().contains(&q)))
                });
                let hit = if has("name") {
                    Some("name")
                } else if in_commands {
                    Some("command")
                } else if has("cwd") || has("host") {
                    Some("path")
                } else {
                    let id = field(e, "id").unwrap_or_default().to_string();
                    self.text(&id).contains(&q).then_some("output")
                };
                if let Some(hit) = hit {
                    let mut hit_entry = self.entries[i].clone();
                    hit_entry.insert("hit".into(), json!(hit));
                    out.push(Value::Object(hit_entry));
                }
            }
            if out.len() >= 500 {
                break;
            }
        }
        json!({ "total": self.entries.len(), "results": out })
    }

    pub fn flush_sync(&self) {
        self.writer.flush_sync();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_hits_name_command_and_stripped_output() {
        let dir = std::env::temp_dir().join(format!("termorc-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut lib = Library::new(dir.clone());
        let entry = |id: &str, name: &str| json!({ "id": id, "name": name, "endedAt": now_ms(), "commands": [{ "cmd": "cargo build" }] }).as_object().unwrap().clone();
        lib.add(entry("a", "deploy"), "\x1b[31mERROR\x1b[0m: disk full\r\n".into());
        lib.add(entry("b", "notes"), "all good".into());
        let q = |q: &str| serde_json::from_value::<Query>(json!({ "q": q })).unwrap();
        let hits = |v: Value| v["results"].as_array().unwrap().iter().map(|e| (e["id"].as_str().unwrap().to_string(), e["hit"].as_str().unwrap().to_string())).collect::<Vec<_>>();
        assert_eq!(hits(lib.search(q("deploy"))), [("a".into(), "name".into())]);
        assert_eq!(hits(lib.search(q("error: disk"))), [("a".into(), "output".into())]);
        assert_eq!(lib.search(q("cargo"))["results"].as_array().unwrap().len(), 2);
        lib.remove("a");
        assert_eq!(lib.search(q(""))["total"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
