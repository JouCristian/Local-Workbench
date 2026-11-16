//! Models use whitelisted reads and operation previews. Only explicit UI
//! confirmation can apply business writes; credentials never leave this module.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{collections::HashMap, io::Read, str::FromStr, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::watch;
use unicode_normalization::UnicodeNormalization;
#[cfg(test)]
#[path = "assistant_agent.rs"]
mod agent;
#[path = "assistant_runtime.rs"]
mod runtime;
#[cfg(test)]
#[path = "assistant_stream.rs"]
mod stream;
#[path = "assistant_voice.rs"]
pub(crate) mod voice;

#[cfg(test)]
#[path = "assistant_tests.rs"]
mod tests;

#[derive(Default)]
pub struct Requests(Mutex<HashMap<String, watch::Sender<bool>>>);
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("org.localworkbench.desktop", "deepseek-api-key")
        .map_err(|_| "无法访问 Windows 凭据管理器".to_string())
}
#[tauri::command]
pub fn assistant_key_status() -> Result<bool, String> {
    match credential()?.get_password() {
        Ok(key) => Ok(!key.is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("无法读取 Windows 凭据，请检查系统凭据管理器".into()),
    }
}
#[tauri::command]
pub fn assistant_save_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.len() < 12 || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("请输入有效的 DeepSeek API Key".into());
    }
    credential()?
        .set_password(key)
        .map_err(|_| "API Key 保存失败".into())
}
#[tauri::command]
pub fn assistant_delete_key() -> Result<(), String> {
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("API Key 移除失败".into()),
    }
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建网络连接".into())
}
fn secret() -> Result<String, String> {
    credential()?
        .get_password()
        .map_err(|_| "请先设置 DeepSeek API Key".into())
}
fn provider_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "API Key 无效或无访问权限，请检查设置",
        402 => "DeepSeek 账户余额不足",
        429 => "请求过于频繁，请稍后重试",
        400 | 422 => "DeepSeek 未接受请求，请检查模型和附件，或减少上下文",
        _ => "DeepSeek 服务暂时不可用，请稍后重试",
    }
    .into()
}
#[tauri::command]
pub async fn assistant_test_connection() -> Result<(), String> {
    let response = client()?
        .get("https://api.deepseek.com/models")
        .bearer_auth(secret()?)
        .send()
        .await
        .map_err(|_| "无法连接 DeepSeek，请检查网络".to_string())?;
    if !response.status().is_success() {
        return Err(provider_error(response.status()));
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Delta { text: String },
    Thinking,
    Phase { phase: String },
    Tool { step: Value },
}
#[derive(Deserialize)]
pub struct ChatRequest {
    id: String,
    model: String,
    messages: Vec<Value>,
    context: Value,
    #[serde(default)]
    drafts: Vec<DraftSnapshot>,
    #[serde(default)]
    action_event: Option<ActionEvent>,
}
#[derive(Clone, Deserialize, Serialize)]
struct DraftSnapshot {
    id: String,
    revision: i64,
    state: String,
    proposals: Vec<Value>,
}
#[derive(Clone, Deserialize, Serialize)]
struct ActionEvent {
    kind: String,
    message_id: String,
    count: usize,
}
#[tauri::command]
pub async fn assistant_chat(
    app: tauri::AppHandle,
    request: ChatRequest,
    events: Channel<StreamEvent>,
    state: State<'_, Requests>,
) -> Result<String, String> {
    if !["deepseek-flash", "deepseek-v4-pro"].contains(&request.model.as_str())
        || uuid::Uuid::parse_str(&request.id).is_err()
    {
        return Err("无效的模型或请求".into());
    }
    if request.messages.is_empty()
        || request.messages.len() > 32
        || request.context.to_string().len() > 1_500_000
        || request
            .messages
            .iter()
            .any(|m| ![Some("user"), Some("assistant")].contains(&m["role"].as_str()))
        || request
            .messages
            .iter()
            .map(|m| m.to_string().len())
            .sum::<usize>()
            > 12_000_000
    {
        return Err("对话或上下文过长，请开启新对话或减少附件".into());
    }
    if request.drafts.len() > 12
        || serde_json::to_vec(&request.drafts)
            .map_err(|_| "草稿数据无效")?
            .len()
            > 1_500_000
        || request.drafts.iter().any(|d| {
            d.revision < 0
                || d.proposals.len() > 20
                || !["pending", "applied", "cancelled"].contains(&d.state.as_str())
        })
    {
        return Err("草稿过多或内容过长，请先处理已有草稿".into());
    }
    let key = secret()?;
    let http = client()?;
    let (sender, mut cancel) = watch::channel(false);
    {
        let mut running = state.0.lock().map_err(|_| "请求状态异常")?;
        if !running.is_empty() {
            return Err("已有请求正在进行".into());
        }
        running.insert(request.id.clone(), sender);
    }
    let work = async {
        let mut conn = crate::assistant_operations::connect(&app).await?;
        let conversation = request.context["conversation_id"]
            .as_str()
            .ok_or("对话标识缺失")?;
        let message = request.context["message_id"]
            .as_str()
            .ok_or("消息标识缺失")?;
        sqlx::query("UPDATE assistant_runs SET state='stopped',finished_at=? WHERE conversation_id=? AND state='running'")
            .bind(crate::assistant_operations::stamp()).bind(conversation).execute(&mut conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO assistant_runs(id,conversation_id,message_id,state,started_at) VALUES (?,?,?,'running',?)")
            .bind(&request.id).bind(conversation).bind(message).bind(crate::assistant_operations::stamp()).execute(&mut conn).await.map_err(|e|e.to_string())?;
        runtime::run(&http, &key, &request, &events, &mut conn).await
    };
    let result = tokio::select! { result = tokio::time::timeout(Duration::from_secs(300),work) => result.unwrap_or_else(|_|Err("本轮处理超时，已准备的预览仍保留，请继续或重试".into())), _ = cancel.changed() => Err("已停止生成，已准备的操作仍保留，业务记录未自动保存".into()) };
    if let Ok(mut conn) = crate::assistant_operations::connect(&app).await {
        let status = if result.is_ok() {
            "complete"
        } else if *cancel.borrow() {
            "stopped"
        } else {
            "failed"
        };
        let _ = sqlx::query("UPDATE assistant_runs SET state=?,finished_at=?,error=? WHERE id=?")
            .bind(status)
            .bind(crate::assistant_operations::stamp())
            .bind(result.as_ref().err().map(String::as_str).unwrap_or(""))
            .bind(&request.id)
            .execute(&mut conn)
            .await;
        let _ = sqlx::query(
            "UPDATE assistant_steps SET state='failed',result=? WHERE run_id=? AND state='running'",
        )
        .bind(serde_json::json!({"ok":false,"error":"执行已中断，可重新查询最新状态"}).to_string())
        .bind(&request.id)
        .execute(&mut conn)
        .await;
    }
    if let Ok(mut running) = state.0.lock() {
        running.remove(&request.id);
    }
    result
}

// Retry only a confirmed empty response, once. Interruptions, invalid JSON and
// provider rejections must remain visible failures, never hidden retries.
#[cfg(test)]
async fn request_completion(
    http: &reqwest::Client,
    endpoint: &str,
    key: &str,
    model: &str,
    mut messages: Vec<Value>,
    events: &Channel<StreamEvent>,
) -> Result<String, String> {
    for attempt in 0..2 {
        if attempt == 1 {
            messages.push(json!({"role":"system","content":"上一请求没有生成可见正文。请回答最新用户问题，返回完整 JSON 对象，answer 为非空字符串，proposals 为数组。不要输出空内容或仅空白；普通问答和长篇创作都在 answer 中完整作答。"}));
        }
        let response = http
            .post(endpoint)
            .bearer_auth(key)
            .json(&json!({"model":model,"messages":messages,
                "thinking":{"type":"disabled"}, "response_format":{"type":"json_object"},
                "max_tokens":16384,"stream":attempt == 0}))
            .send()
            .await
            .map_err(|_| "网络请求失败或超时，请检查网络后重试".to_string())?;
        if !response.status().is_success() {
            return Err(provider_error(response.status()));
        }
        match receive_completion(response, &events).await {
            Err(ref error) if attempt == 0 && error == stream::EMPTY_REPLY => continue,
            result => return result,
        }
    }
    unreachable!()
}
#[cfg(test)]
async fn receive_completion(
    response: reqwest::Response,
    events: &Channel<StreamEvent>,
) -> Result<String, String> {
    stream::receive(response, events).await
}
#[tauri::command]
pub fn assistant_cancel(id: String, state: State<'_, Requests>) {
    if let Ok(running) = state.0.lock() {
        if let Some(sender) = running.get(&id) {
            let _ = sender.send(true);
        }
    }
}

#[derive(Serialize)]
pub struct Attachment {
    id: String,
    name: String,
    kind: String,
    content: String,
    bytes: usize,
}
#[tauri::command]
pub fn assistant_attachment(path: String) -> Result<Attachment, String> {
    let path = std::path::Path::new(&path);
    let mut file = std::fs::File::open(path).map_err(|_| "无法读取所选文件")?;
    let metadata = file.metadata().map_err(|_| "无法读取文件信息")?;
    if !metadata.is_file() || metadata.len() > 5 * 1024 * 1024 {
        return Err("请选择 5 MB 以内的文件".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(5 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "文件读取失败")?;
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("文件超过 5 MB".into());
    }
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("文件名无效")?
        .to_string();
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    };
    let (kind, content) = if let Some(mime) = mime {
        (
            "image",
            format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)),
        )
    } else {
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["txt", "md", "csv", "json"].contains(&ext.as_str()) {
            return Err("暂支持 TXT、Markdown、CSV、JSON 和 PNG/JPEG/GIF/WebP 图片；PDF、Office 文档请先转换为文本或图片".into());
        }
        if bytes.len() > 100_000 {
            return Err("文本附件最多 100 KB，请拆分内容".into());
        }
        let text = String::from_utf8(bytes.clone()).map_err(|_| "文本需要 UTF-8 编码")?;
        if text.contains('\0') {
            return Err("所选文件不是有效文本".into());
        }
        ("text", text.trim_start_matches('\u{feff}').into())
    };
    Ok(Attachment {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        kind: kind.into(),
        content,
        bytes: bytes.len(),
    })
}

#[derive(Deserialize)]
pub struct Insert {
    table: String,
    record: Value,
}
fn norm(s: &str) -> String {
    s.nfkc()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}
fn clock(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[0..2].iter().chain(b[3..5].iter()).all(u8::is_ascii_digit)
        && &s[..2] < "24"
        && &s[3..] < "60"
}
fn string<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
#[cfg(test)]
pub async fn apply(
    conn: &mut SqliteConnection,
    message: &str,
    inserts: &[Insert],
) -> Result<usize, String> {
    apply_revision(conn, message, inserts, None).await
}
async fn apply_revision(
    conn: &mut SqliteConnection,
    message: &str,
    inserts: &[Insert],
    expected_revision: Option<i64>,
) -> Result<usize, String> {
    if inserts.is_empty() || inserts.len() > 20 {
        return Err("一次请确认 1–20 条草稿".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let state: Option<String> = sqlx::query_scalar(
        "SELECT draft_state FROM assistant_messages WHERE id=? AND role='assistant'",
    )
    .bind(message)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if state.as_deref() == Some("applied") {
        return Ok(0);
    }
    if state.as_deref() != Some("pending") {
        return Err("草稿已取消或不存在".into());
    }
    if let Some(expected) = expected_revision {
        let revision: i64 =
            sqlx::query_scalar("SELECT draft_revision FROM assistant_messages WHERE id=?")
                .bind(message)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        if revision != expected {
            return Err("草稿已变化，请查看最新内容后再确认".into());
        }
    }
    let mut ordered: Vec<&Insert> = inserts.iter().collect();
    ordered.sort_by_key(|i| if i.table == "tasks" { 0 } else { 1 });
    for insert in ordered {
        if !["tasks", "schedules", "events"].contains(&insert.table.as_str()) {
            return Err("不支持的草稿类型".into());
        }
        let v = &insert.record;
        let columns = super::TABLES
            .iter()
            .find(|(t, _)| *t == insert.table)
            .unwrap()
            .1;
        if !v.is_object()
            || columns
                .iter()
                .any(|c| v.get(*c).is_none() && *c != "archived_at" && *c != "completed_at")
            || columns
                .iter()
                .any(|c| !v[*c].is_string() && !v[*c].is_null())
            || uuid::Uuid::parse_str(string(v, "id")).is_err()
            || string(v, "title").trim().is_empty()
            || string(v, "title").chars().count() > 300
            || string(v, "notes").chars().count() > 20000
            || !v["archived_at"].is_null()
            || string(v, "created_at").is_empty()
            || string(v, "updated_at").is_empty()
        {
            return Err("草稿字段无效".into());
        }
        for field in ["date", "due_date"] {
            if let Some(date) = v[field].as_str() {
                let normalized: Option<String> = sqlx::query_scalar("SELECT date(?,'+0 days')")
                    .bind(date)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                if date.len() != 10
                    || date < "1900-01-01"
                    || date > "9999-12-31"
                    || normalized.as_deref() != Some(date)
                {
                    return Err("草稿日期无效".into());
                }
            }
        }
        for field in ["due_time", "start_time", "end_time"] {
            if v[field].as_str().is_some_and(|s| !clock(s)) {
                return Err("草稿时间无效".into());
            }
        }
        if insert.table == "tasks" {
            if string(v, "status") != "todo"
                || !["low", "medium", "high"].contains(&string(v, "priority"))
                || (!v["due_time"].is_null() && v["due_date"].is_null())
            {
                return Err("任务状态或截止时间无效".into());
            }
            if let Some(id) = v["project_id"].as_str() {
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM projects WHERE id=? AND archived_at IS NULL",
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if count != 1 {
                    return Err("项目不存在或已归档".into());
                }
            }
            let rows=sqlx::query("SELECT title FROM tasks WHERE archived_at IS NULL AND project_id IS ? AND stage_id IS ?")
                .bind(v["project_id"].as_str()).bind(v["stage_id"].as_str()).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
            if rows
                .iter()
                .any(|r| norm(r.get("title")) == norm(string(v, "title")))
            {
                return Err("已有同名任务，请关联现有任务".into());
            }
        } else if insert.table == "schedules" {
            let period = string(v, "period");
            if !["anytime", "morning", "afternoon", "evening", "exact"].contains(&period)
                || (period == "exact" && v["start_time"].is_null())
                || (period != "exact" && (!v["start_time"].is_null() || !v["end_time"].is_null()))
                || v["end_time"]
                    .as_str()
                    .is_some_and(|e| e <= string(v, "start_time"))
            {
                return Err("日程时间安排无效".into());
            }
            if let Some(id) = v["task_id"].as_str() {
                let count:i64=sqlx::query_scalar("SELECT count(*) FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.archived_at IS NULL AND p.archived_at IS NULL").bind(id).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
                if count != 1 {
                    return Err("关联任务不存在或已归档".into());
                }
            }
            let rows=sqlx::query("SELECT title FROM schedules WHERE task_id IS ? AND date=? AND period=? AND start_time IS ?")
                .bind(v["task_id"].as_str()).bind(string(v,"date")).bind(period).bind(v["start_time"].as_str()).fetch_all(&mut *tx).await.map_err(|e|e.to_string())?;
            if rows.iter().any(|r| {
                !v["task_id"].is_null() || norm(r.get("title")) == norm(string(v, "title"))
            }) {
                return Err("该任务在该时段已有日程".into());
            }
        } else {
            if !["event", "rest"].contains(&string(v, "kind")) {
                return Err("事件类型无效".into());
            }
            let rows = sqlx::query("SELECT title FROM events WHERE date=? AND kind=?")
                .bind(string(v, "date"))
                .bind(string(v, "kind"))
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            if rows
                .iter()
                .any(|r| norm(r.get("title")) == norm(string(v, "title")))
            {
                return Err("该日期已有同名事件".into());
            }
        }
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            insert.table,
            columns.join(","),
            vec!["?"; columns.len()].join(",")
        );
        let mut query = sqlx::query(&sql);
        for column in columns {
            query = query.bind(v[*column].as_str());
        }
        query
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("未保存，草稿关联或字段有误：{}", e))?;
    }
    sqlx::query(
        "UPDATE assistant_messages SET draft_state='applied',draft_revision=draft_revision+1 WHERE id=? AND draft_state='pending'",
    )
    .bind(message)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(inserts.len())
}
#[tauri::command]
pub async fn assistant_apply(
    app: tauri::AppHandle,
    message_id: String,
    inserts: Vec<Insert>,
    expected_revision: Option<i64>,
) -> Result<usize, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("workbench.db");
    let options = SqliteConnectOptions::from_str("sqlite:")
        .map_err(|e| e.to_string())?
        .filename(path)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    apply_revision(&mut conn, &message_id, &inserts, expected_revision).await
}
