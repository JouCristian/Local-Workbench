//! Business writes are possible only through the user-confirmed operation command.
//! Models can prepare/revise previews, never invoke apply or arbitrary SQL.
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};
use tauri::Manager;

pub type Result<T> = std::result::Result<T, String>;
pub fn stamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn columns(table: &str) -> Result<&'static [&'static str]> {
    super::TABLES
        .iter()
        .find(|(t, _)| *t == table)
        .map(|(_, c)| *c)
        .ok_or("不支持的业务类型".into())
}
pub async fn connect(app: &tauri::AppHandle) -> Result<SqliteConnection> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("workbench.db");
    SqliteConnection::connect_with(
        &SqliteConnectOptions::from_str("sqlite:")
            .map_err(|e| e.to_string())?
            .filename(path)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(10)),
    )
    .await
    .map_err(|e| e.to_string())
}
pub async fn load(conn: &mut SqliteConnection) -> Result<Value> {
    let mut data = json!({});
    for (table, fields) in super::TABLES {
        let rows = sqlx::query(&format!(
            "SELECT {} FROM {} ORDER BY id",
            fields.join(","),
            table
        ))
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        data[*table] = Value::Array(
            rows.iter()
                .map(|r| {
                    let mut value = json!({});
                    for field in *fields {
                        value[*field] = r
                            .get::<Option<String>, _>(*field)
                            .map(Value::String)
                            .unwrap_or(Value::Null);
                    }
                    value
                })
                .collect(),
        );
    }
    Ok(data)
}
pub fn rows<'a>(data: &'a Value, table: &str) -> &'a [Value] {
    data[table].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn find<'a>(data: &'a Value, table: &str, id: &str) -> Option<&'a Value> {
    rows(data, table).iter().find(|r| text(r, "id") == id)
}
fn norm(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfkc()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}
pub fn date(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .filter(|d| d.format("%Y-%m-%d").to_string() == s && s >= "1900-01-01" && s <= "9999-12-31")
        .ok_or("日期无效，请使用真实的本地日历日期".into())
}
fn clock(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[..2].iter().chain(b[3..].iter()).all(u8::is_ascii_digit)
        && &s[..2] < "24"
        && &s[3..] < "60"
}
pub fn active(data: &Value, table: &str, row: &Value) -> bool {
    if !row["archived_at"].is_null() {
        return false;
    }
    let project = if table == "schedules" {
        find(data, "tasks", text(row, "task_id")).map(|t| text(t, "project_id"))
    } else {
        Some(text(row, "project_id"))
    };
    if table == "schedules"
        && find(data, "tasks", text(row, "task_id")).is_some_and(|t| !t["archived_at"].is_null())
    {
        return false;
    }
    !project
        .and_then(|id| find(data, "projects", id))
        .is_some_and(|p| !p["archived_at"].is_null())
}
fn validate(table: &str, row: &Value, data: &Value) -> Result<()> {
    let fields = columns(table)?;
    for f in fields {
        let optional = matches!(
            *f,
            "archived_at"
                | "completed_at"
                | "due_date"
                | "due_time"
                | "stage_id"
                | "task_id"
                | "start_time"
                | "end_time"
        ) || (*f == "project_id" && table == "tasks");
        if !optional && !row[*f].is_string() {
            return Err(format!("字段 {f}：必填文本不能为空；备注无需填写内容时用空文本，其它必填业务信息须从上下文确定，不能编造"));
        }
        if !row[*f].is_string() && !row[*f].is_null() {
            return Err(format!(
                "字段 {f}：只接受文本或可选字段的null，不接受数字、布尔或对象"
            ));
        }
    }
    if uuid::Uuid::parse_str(text(row, "id")).is_err() {
        return Err("字段 id：需要有效UUID；新建时省略id，由程序生成".into());
    }
    if text(row, "title").trim().is_empty() {
        return Err("字段 title：缺少记录标题（不是整组操作说明）。新建时可根据已明确的用户意图拟定简短标题，无需因此重新询问是否创建；修改时不能清空标题".into());
    }
    if text(row, "title").chars().count() > 300 {
        return Err("字段 title：标题超过300字，请缩短标题，不要丢弃其它有效字段".into());
    }
    if text(row, "notes").chars().count() > 20000 {
        return Err("字段 notes：备注超过20000字，请精简；不要擅自删掉用户要求保留的内容".into());
    }
    for f in ["date", "due_date", "start_date", "end_date"] {
        if let Some(s) = row[f].as_str() {
            date(s).map_err(|e| format!("字段 {f}：{e}；可选日期未提供时用null或省略，必填日期不明确时询问用户，不能猜测"))?;
        }
    }
    for f in ["due_time", "start_time", "end_time"] {
        if row[f].as_str().is_some_and(|s| !clock(s)) {
            return Err(format!(
                "字段 {f}：需要有效的HH:mm；未指定的可选时刻留空，不能猜测小时"
            ));
        }
    }
    for f in ["created_at", "updated_at", "archived_at", "completed_at"] {
        if row[f]
            .as_str()
            .is_some_and(|s| DateTime::parse_from_rfc3339(s).is_err())
        {
            return Err(format!(
                "字段 {f}：时间戳无效，需有效ISO时间戳或可选字段的null"
            ));
        }
    }
    for (field, parent) in [
        ("project_id", "projects"),
        ("stage_id", "stages"),
        ("task_id", "tasks"),
    ] {
        if let Some(id) = row[field].as_str() {
            if find(data, parent, id).is_none() {
                return Err(format!("字段 {field}：关联对象不存在，请查询真实UUID或使用同组新建对象ref，不得猜测关联"));
            }
        }
    }
    if table == "stages"
        && (row["start_date"].is_null()
            || row["end_date"].is_null()
            || text(row, "start_date") > text(row, "end_date")
            || row["project_id"].is_null())
    {
        return Err("字段 project_id/start_date/end_date：阶段必须属于项目，且起止日期必填、结束不早于开始；有实质歧义时询问用户".into());
    }
    if table == "tasks" {
        if !["todo", "doing", "done"].contains(&text(row, "status")) {
            return Err("字段 status：任务状态只接受todo/doing/done".into());
        }
        if !["low", "medium", "high"].contains(&text(row, "priority")) {
            return Err("字段 priority：任务优先级只接受low/medium/high".into());
        }
        if !row["due_time"].is_null() && row["due_date"].is_null() {
            return Err("字段 due_date：具体截止时刻必须有截止日期，请从上下文提取或询问用户；未提供的截止信息留空，不能用执行日期代替".into());
        }
        if let Some(s) = find(data, "stages", text(row, "stage_id")) {
            if s["project_id"] != row["project_id"] {
                return Err(
                    "字段 stage_id/project_id：阶段不属于所选项目，请重新查询并核实归属，不得猜测"
                        .into(),
                );
            }
        }
        if active(data, table, row)
            && rows(data, "tasks").iter().any(|r| {
                r["id"] != row["id"]
                    && active(data, "tasks", r)
                    && r["project_id"] == row["project_id"]
                    && r["stage_id"] == row["stage_id"]
                    && norm(text(r, "title")) == norm(text(row, "title"))
            })
        {
            return Err("同一分类和阶段已有同名任务，请修改原任务".into());
        }
    }
    if table == "schedules" {
        let period = text(row, "period");
        if !["anytime", "morning", "afternoon", "evening", "exact"].contains(&period) {
            return Err(
                "字段 period：只接受anytime/morning/afternoon/evening/exact，请按用户原意选择时段"
                    .into(),
            );
        }
        if period == "exact" && row["start_time"].is_null() {
            return Err("字段 start_time：精确日程缺少开始时刻；从已有对话提取，仍不明确才询问，不得自动改成模糊时段".into());
        }
        if period != "exact" && (!row["start_time"].is_null() || !row["end_time"].is_null()) {
            return Err("字段 start_time/end_time：模糊时段不能指定小时，应设为null；保留用户选择的上午/下午/晚上".into());
        }
        if row["end_time"]
            .as_str()
            .is_some_and(|e| e <= text(row, "start_time"))
        {
            return Err("字段 end_time：结束必须晚于开始；核对用户原意，不得自行改变时间或丢弃用户明确的结束时间".into());
        }
        if !active(data, table, row) {
            return Err("请先恢复日程所属的任务和项目".into());
        }
        if rows(data, table).iter().any(|r| {
            r["id"] != row["id"]
                && r["task_id"] == row["task_id"]
                && r["date"] == row["date"]
                && r["period"] == row["period"]
                && r["start_time"] == row["start_time"]
                && (!row["task_id"].is_null() || norm(text(r, "title")) == norm(text(row, "title")))
        }) {
            return Err("该任务在同一天同一时段已有安排".into());
        }
    }
    if table == "events" {
        if !["event", "rest"].contains(&text(row, "kind")) {
            return Err("字段 kind：事件类型只接受event/rest".into());
        }
        if rows(data, table).iter().any(|r| {
            r["id"] != row["id"]
                && r["date"] == row["date"]
                && r["kind"] == row["kind"]
                && norm(text(r, "title")) == norm(text(row, "title"))
        }) {
            return Err("该日期已有同名事件".into());
        }
    }
    Ok(())
}
fn effects(data: &Value, table: &str, id: &str, action: &str) -> Vec<Value> {
    let mut result = vec![];
    if let Some(r) = find(data, table, id) {
        result.push(json!({"table":table,"record":r}));
    }
    if action != "delete" {
        return result;
    }
    let tids: HashSet<&str> = rows(data, "tasks")
        .iter()
        .filter(|r| {
            table == "projects" && text(r, "project_id") == id
                || table == "tasks" && text(r, "id") == id
        })
        .map(|r| text(r, "id"))
        .collect();
    for t in ["stages", "tasks", "schedules"] {
        for r in rows(data, t) {
            let include = match t {
                "stages" => table == "projects" && text(r, "project_id") == id,
                "tasks" => {
                    table == "projects" && text(r, "project_id") == id
                        || table == "stages" && text(r, "stage_id") == id
                }
                _ => tids.contains(text(r, "task_id")),
            };
            if include && !(t == table && text(r, "id") == id) {
                result.push(json!({"table":t,"record":r}));
            }
        }
    }
    result
}
fn simulate_delete(data: &mut Value, table: &str, id: &str) {
    let affected = effects(data, table, id, "delete");
    for item in affected {
        let t = text(&item, "table");
        let rid = text(&item["record"], "id");
        if table == "stages" && t == "tasks" {
            if let Some(task) = data[t]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| text(r, "id") == rid)
            {
                task["stage_id"] = Value::Null;
            }
        } else {
            data[t]
                .as_array_mut()
                .unwrap()
                .retain(|r| text(r, "id") != rid);
        }
    }
}
pub fn preview(source: &Value, actions: &[Value]) -> Result<(Vec<Value>, Vec<Value>)> {
    if actions.is_empty() || actions.len() > 50 {
        return Err("一次操作需要包含1至50项改动".into());
    }
    let mut data = source.clone();
    let now = stamp();
    let mut normalized = actions.to_vec();
    let mut aliases = HashMap::new();
    let mut targets = HashSet::new();
    for (i, a) in normalized.iter_mut().enumerate() {
        columns(text(a, "table"))?;
        if a["key"].is_null() {
            a["key"] = json!(format!("item{}", i + 1));
        }
        if text(a, "action") == "create" {
            if a["id"].is_null() {
                a["id"] = json!(uuid::Uuid::new_v4().to_string());
            }
            if !text(a, "ref").is_empty()
                && aliases
                    .insert(text(a, "ref").to_string(), text(a, "id").to_string())
                    .is_some()
            {
                return Err("新建对象的引用名称重复".into());
            }
        }
    }
    let positions: HashMap<String, usize> = normalized
        .iter()
        .enumerate()
        .map(|(i, a)| (text(a, "key").to_string(), i + 1))
        .collect();
    let context = |a: &Value| {
        format!(
            "第{}项（{}，步骤{}）",
            positions.get(text(a, "key")).copied().unwrap_or(0),
            text(a, "table"),
            text(a, "key")
        )
    };
    let mut keys = HashSet::new();
    let mut items = vec![];
    // Stable dependency ordering permits new project -> stage -> task -> schedules.
    normalized.sort_by_key(|a| {
        if text(a, "action") == "create" {
            match text(a, "table") {
                "projects" => 0,
                "stages" => 1,
                "tasks" => 2,
                _ => 3,
            }
        } else {
            4
        }
    });
    for a in &mut normalized {
        let table = text(a, "table").to_string();
        let action = text(a, "action").to_string();
        let id = text(a, "id").to_string();
        if !["create", "update", "delete", "archive", "restore"].contains(&action.as_str())
            || uuid::Uuid::parse_str(&id).is_err()
            || text(a, "key").is_empty()
            || !keys.insert(text(a, "key").to_string())
            || !targets.insert(format!("{table}/{id}"))
        {
            return Err("操作类型、目标或标识无效，不能重复修改同一记录".into());
        }
        let before = find(&data, &table, &id).cloned().unwrap_or(Value::Null);
        if action == "create" && !before.is_null() || action != "create" && before.is_null() {
            return Err("目标已不存在或标识冲突，请重新查询".into());
        }
        if table == "tasks" && action == "update" && !active(source, "tasks", &before) {
            return Err("请先恢复归档任务和所属项目，再修改任务".into());
        }
        let affected = effects(source, &table, &id, &action);
        let mut after = before.clone();
        let mut inferred_fields = vec![];
        if action == "delete" {
            simulate_delete(&mut data, &table, &id);
            after = Value::Null;
        } else {
            if action == "create" {
                after = json!({"id":id,"title":"","notes":"","created_at":now,"updated_at":now});
                for f in columns(&table)? {
                    if after.get(*f).is_none() {
                        after[*f] = Value::Null;
                    }
                }
                match table.as_str() {
                    "tasks" => {
                        after["status"] = json!("todo");
                        after["priority"] = json!("medium");
                    }
                    "schedules" => after["period"] = json!("anytime"),
                    "events" => after["kind"] = json!("event"),
                    _ => (),
                }
            }
            if matches!(action.as_str(), "archive" | "restore") {
                if !["tasks", "projects"].contains(&table.as_str()) {
                    return Err("只有任务和项目支持归档".into());
                }
                if action == "archive" && a["archive_stamp"].is_null() {
                    a["archive_stamp"] = json!(now);
                }
                after["archived_at"] = if action == "archive" {
                    a["archive_stamp"].clone()
                } else {
                    Value::Null
                };
            }
            if let Some(fields) = a["fields"].as_object() {
                for (k, v) in fields {
                    if !columns(&table)?.contains(&k.as_str())
                        || ["id", "created_at", "updated_at", "archived_at"].contains(&k.as_str())
                    {
                        return Err(format!("{}，字段 {k}：不适用于此业务类型或不能编辑；阶段没有notes，不要添加无关字段",context(a)));
                    }
                    if !v.is_string() && !v.is_null() {
                        return Err(format!(
                            "{}，字段 {k}：字段值必须是文本或可选字段的null",
                            context(a)
                        ));
                    }
                    after[k] = if ["project_id", "stage_id", "task_id"].contains(&k.as_str()) {
                        v.as_str()
                            .and_then(|s| aliases.get(s))
                            .map(|id| json!(id))
                            .unwrap_or(v.clone())
                    } else {
                        v.clone()
                    };
                }
            } else if !a["fields"].is_null() {
                return Err("修改字段格式无效".into());
            }
            if let Some(days) = a["shift_due_days"].as_i64() {
                if table != "tasks"
                    || action == "create"
                    || !(-3650..=3650).contains(&days)
                    || a["fields"].get("due_date").is_some()
                {
                    return Err("顺延需要已有任务的截止日期，且不能同时指定另一个截止日期".into());
                }
                let shifted = date(text(&before, "due_date"))?
                    .checked_add_signed(Duration::days(days))
                    .ok_or("顺延日期超出范围")?
                    .format("%Y-%m-%d")
                    .to_string();
                date(&shifted)?;
                after["due_date"] = json!(shifted);
                if !a["fields"].is_object() {
                    a["fields"] = json!({});
                }
                a["fields"]["due_date"] = after["due_date"].clone();
                a.as_object_mut().unwrap().remove("shift_due_days");
            }
            after["updated_at"] = json!(now);
            if let Some(title) = after["title"].as_str() {
                after["title"] = json!(title.trim());
            }
            // Mirror the regular linked-schedule editor. Only a new schedule may
            // inherit its verified task's title; never repair dates, times or edits
            // by guessing. Persist the default in actions so confirmation replays
            // the exact preview even if the parent title changes later.
            if action == "create"
                && table == "schedules"
                && (after["title"].is_null()
                    || after["title"].as_str().is_some_and(|s| s.trim().is_empty()))
            {
                if let Some(task) = find(&data, "tasks", text(&after, "task_id")) {
                    if !text(task, "title").trim().is_empty() {
                        after["title"] = task["title"].clone();
                        if !a["fields"].is_object() {
                            a["fields"] = json!({});
                        }
                        a["fields"]["title"] = after["title"].clone();
                        inferred_fields.push(json!({"field":"title","source":"linked_task","explanation":"未提供日程标题，沿用已核实的关联任务标题，请用户在预览中核对"}));
                    }
                }
            }
            // stage has no notes column.
            let allowed = columns(&table)?;
            after
                .as_object_mut()
                .unwrap()
                .retain(|k, _| allowed.contains(&k.as_str()));
            if action == "create" {
                data[&table].as_array_mut().unwrap().push(after.clone());
            } else {
                *data[&table]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|r| text(r, "id") == id)
                    .unwrap() = after.clone();
            }
        }
        let mut item = json!({"key":a["key"],"table":table,"action":action,"id":id,"before":before,"after":after,"affected":affected});
        if !inferred_fields.is_empty() {
            item["inferred_fields"] = json!(inferred_fields);
        }
        items.push(item);
    }
    for item in &items {
        if !item["after"].is_null() {
            let table = text(item, "table");
            let row = &item["after"];
            if table == "tasks"
                && ["create", "restore"].contains(&text(item, "action"))
                && !active(&data, table, row)
            {
                return Err("请先恢复所属项目，再创建或恢复任务".into());
            }
            if table == "stages" && !active(&data, table, row) {
                return Err("请先恢复所属项目，再编辑阶段".into());
            }
            validate(table, row, &data).map_err(|e| {
                format!("{}，{e}；本组预览未生成，未写入任何业务记录", context(item))
            })?;
        }
    }
    // Moving a stage must not invalidate its existing tasks; restoring a project must
    // not reveal duplicates that accumulated while it was archived.
    for item in &items {
        if text(item, "table") == "stages" && text(item, "action") == "delete" {
            for affected in item["affected"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| text(a, "table") == "tasks")
            {
                if let Some(task) = find(&data, "tasks", text(&affected["record"], "id")) {
                    validate("tasks", task, &data)
                        .map_err(|e| format!("{}影响的关联任务校验失败：{e}", context(item)))?;
                }
            }
        }
        if ["projects", "stages"].contains(&text(item, "table")) {
            for task in rows(&data, "tasks").iter().filter(|t| {
                text(t, "project_id") == text(item, "id") || text(t, "stage_id") == text(item, "id")
            }) {
                validate("tasks", task, &data)
                    .map_err(|e| format!("{}影响的关联任务校验失败：{e}", context(item)))?;
            }
        }
    }
    // Nested deletes/updates are ambiguous and could invalidate the displayed preview.
    for item in &items {
        for affected in item["affected"].as_array().unwrap() {
            if text(affected, "table") != text(item, "table")
                && items.iter().any(|other| {
                    other["table"] == affected["table"] && other["id"] == affected["record"]["id"]
                })
            {
                return Err("不能同时操作要被级联删除或解除关联的子记录，请拆分操作".into());
            }
        }
    }
    Ok((normalized, items))
}
fn operation(row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
    let mut v = json!({});
    for field in [
        "id",
        "conversation_id",
        "message_id",
        "title",
        "state",
        "created_at",
        "updated_at",
    ] {
        v[field] = json!(row.get::<String, _>(field));
    }
    v["revision"] = json!(row.get::<i64, _>("revision"));
    v["superseded_by"] = json!(row.get::<Option<String>, _>("superseded_by"));
    for field in ["actions", "preview", "receipt"] {
        v[field] = row
            .get::<Option<String>, _>(field)
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| "操作记录损坏")?
            .unwrap_or(Value::Null);
    }
    Ok(v)
}
pub async fn get(conn: &mut SqliteConnection, id: &str, conversation: &str) -> Result<Value> {
    let row = sqlx::query("SELECT * FROM assistant_operations WHERE id=? AND conversation_id=?")
        .bind(id)
        .bind(conversation)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("操作不存在于当前对话")?;
    operation(&row)
}
pub async fn list(conn: &mut SqliteConnection, conversation: &str) -> Result<Vec<Value>> {
    sqlx::query("SELECT * FROM assistant_operations WHERE conversation_id=? ORDER BY created_at,id")
        .bind(conversation)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(operation)
        .collect()
}
pub async fn prepare(
    conn: &mut SqliteConnection,
    conversation: &str,
    message: &str,
    title: &str,
    actions: &[Value],
    replace: Option<(&str, i64)>,
) -> Result<Value> {
    prepare_plan(conn, conversation, message, title, actions, replace, None).await
}
/// Replacement creates the new preview and retires the old one in one transaction.
pub async fn replace_operation(
    conn: &mut SqliteConnection,
    conversation: &str,
    message: &str,
    title: &str,
    actions: &[Value],
    id: &str,
    revision: i64,
) -> Result<Value> {
    prepare_plan(
        conn,
        conversation,
        message,
        title,
        actions,
        None,
        Some((id, revision)),
    )
    .await
}
async fn prepare_plan(
    conn: &mut SqliteConnection,
    conversation: &str,
    message: &str,
    title: &str,
    actions: &[Value],
    replace: Option<(&str, i64)>,
    supersede: Option<(&str, i64)>,
) -> Result<Value> {
    if title.trim().is_empty() || title.chars().count() > 150 {
        return Err("请提供简短的操作说明".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    if let Some((id, rev)) = replace.or(supersede) {
        let old = get(&mut tx, id, conversation).await?;
        if !["pending", "paused"].contains(&text(&old, "state")) || old["revision"] != rev {
            return Err("操作已变化或结束，请读取最新预览后继续".into());
        }
    }
    let data = load(&mut tx).await?;
    let (actions, items) = preview(&data, actions)?;
    if json!({"actions":actions,"preview":items}).to_string().len() > 600000 {
        return Err("预览内容较多，请分成更小的批次".into());
    }
    if replace.is_none() {
        let prior = list(&mut tx, conversation).await?;
        for old in prior.iter().filter(|o| {
            ["pending", "paused"].contains(&text(o, "state"))
                && supersede.is_none_or(|(id, _)| text(o, "id") != id)
        }) {
            let overlap = old["preview"].as_array().unwrap().iter().any(|p| {
                items.iter().any(|i| {
                    p["table"] == i["table"]
                        && (p["id"] == i["id"]
                            || text(p, "action") == "create"
                                && text(i, "action") == "create"
                                && norm(text(&p["after"], "title"))
                                    == norm(text(&i["after"], "title"))
                                && match text(i, "table") {
                                    "tasks" => {
                                        p["after"]["project_id"] == i["after"]["project_id"]
                                            && p["after"]["stage_id"] == i["after"]["stage_id"]
                                    }
                                    "schedules" => {
                                        p["after"]["task_id"] == i["after"]["task_id"]
                                            && p["after"]["date"] == i["after"]["date"]
                                            && p["after"]["period"] == i["after"]["period"]
                                            && p["after"]["start_time"] == i["after"]["start_time"]
                                    }
                                    "events" => {
                                        p["after"]["date"] == i["after"]["date"]
                                            && p["after"]["kind"] == i["after"]["kind"]
                                    }
                                    "stages" => {
                                        p["after"]["project_id"] == i["after"]["project_id"]
                                    }
                                    _ => true,
                                })
                })
            });
            if overlap {
                return Err(format!("已有涉及这些对象的待确认操作（操作{}，版本{}），请读取它并原位调整，不能重复新建一组",text(old,"id"),old["revision"]));
            }
        }
    }
    let id = replace
        .map(|r| r.0.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = stamp();
    if let Some((_, rev)) = replace {
        let n=sqlx::query("UPDATE assistant_operations SET title=?,actions=?,preview=?,revision=revision+1,updated_at=? WHERE id=? AND conversation_id=? AND revision=? AND state IN ('pending','paused')")
            .bind(title).bind(json!(actions).to_string()).bind(json!(items).to_string()).bind(&now).bind(&id).bind(conversation).bind(rev).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
        if n != 1 {
            return Err("操作已变化，请刷新预览".into());
        }
    } else {
        let n:i64=sqlx::query_scalar("SELECT count(*) FROM assistant_operations WHERE conversation_id=? AND state IN ('pending','paused')").bind(conversation).fetch_one(&mut *tx).await.map_err(|e|e.to_string())?;
        if n >= 12 && supersede.is_none() {
            return Err("请先处理已有的待确认操作，再创建新的一组".into());
        }
        sqlx::query("INSERT INTO assistant_operations(id,conversation_id,message_id,title,state,actions,preview,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?,?)")
            .bind(&id).bind(conversation).bind(message).bind(title).bind(json!(actions).to_string()).bind(json!(items).to_string()).bind(&now).bind(&now).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    }
    if let Some((old, rev)) = supersede {
        let changed=sqlx::query("UPDATE assistant_operations SET state='cancelled',superseded_by=?,revision=revision+1,updated_at=? WHERE id=? AND conversation_id=? AND revision=? AND state IN ('pending','paused')")
            .bind(&id).bind(&now).bind(old).bind(conversation).bind(rev).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
        if changed != 1 {
            return Err("原方案已变化或结束，本次没有替换任何操作".into());
        }
    }
    let result = get(&mut tx, &id, conversation).await?;
    record_presentation(
        &mut tx,
        &id,
        message,
        result["revision"].as_i64().unwrap(),
        if supersede.is_some() {
            "replace"
        } else if replace.is_some() {
            "revise"
        } else {
            "create"
        },
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(result)
}
pub async fn transition(
    conn: &mut SqliteConnection,
    conversation: &str,
    id: &str,
    revision: i64,
    state: &str,
) -> Result<Value> {
    transition_at(conn, conversation, id, revision, state, None).await
}
pub async fn transition_at(
    conn: &mut SqliteConnection,
    conversation: &str,
    id: &str,
    revision: i64,
    state: &str,
    message: Option<&str>,
) -> Result<Value> {
    if !["pending", "paused", "cancelled"].contains(&state) {
        return Err("只能暂停、继续或取消待确认操作".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let n=sqlx::query("UPDATE assistant_operations SET state=?,revision=revision+1,updated_at=? WHERE id=? AND conversation_id=? AND revision=? AND state IN ('pending','paused')")
        .bind(state).bind(stamp()).bind(id).bind(conversation).bind(revision).execute(&mut *tx).await.map_err(|e|e.to_string())?.rows_affected();
    if n != 1 {
        return Err("操作已变化或已结束，请刷新后重试".into());
    }
    if let Some(message) = message {
        record_presentation(&mut tx, id, message, revision + 1, "state").await?;
    }
    let result = get(&mut tx, id, conversation).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(result)
}
async fn record_presentation(
    conn: &mut SqliteConnection,
    id: &str,
    message: &str,
    revision: i64,
    reason: &str,
) -> Result<()> {
    // Empty message denotes a direct field edit, which must not move the editor.
    if message.is_empty() {
        return Ok(());
    }
    sqlx::query("INSERT INTO assistant_operation_presentations(operation_id,message_id,revision,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(operation_id,message_id) DO UPDATE SET revision=excluded.revision,reason=excluded.reason")
        .bind(id).bind(message).bind(revision).bind(reason).bind(stamp()).execute(conn).await.map_err(|e|e.to_string())?;
    Ok(())
}
pub async fn present(
    conn: &mut SqliteConnection,
    conversation: &str,
    id: &str,
    revision: i64,
    message: &str,
) -> Result<Value> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let op = get(&mut tx, id, conversation).await?;
    if !["pending", "paused"].contains(&text(&op, "state")) {
        return Err(
            "该操作已结束，不能再次作为待确认表单；请查看实际结果或准备新的业务操作".into(),
        );
    }
    if op["revision"] != revision {
        return Err("预览已变化，请读取最新版本后重新展示".into());
    }
    record_presentation(&mut tx, id, message, revision, "present").await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(json!({"operation":op,"presented":true,"message_id":message,"business_changes":false}))
}
pub async fn presentations(conn: &mut SqliteConnection, conversation: &str) -> Result<Vec<Value>> {
    let found=sqlx::query("SELECT p.* FROM assistant_operation_presentations p JOIN assistant_operations o ON o.id=p.operation_id WHERE o.conversation_id=? ORDER BY p.sequence")
        .bind(conversation).fetch_all(conn).await.map_err(|e|e.to_string())?;
    Ok(found.iter().map(|r|json!({"sequence":r.get::<i64,_>("sequence"),"operation_id":r.get::<String,_>("operation_id"),"message_id":r.get::<String,_>("message_id"),"revision":r.get::<i64,_>("revision"),"reason":r.get::<String,_>("reason")})).collect())
}
pub async fn apply(
    conn: &mut SqliteConnection,
    conversation: &str,
    id: &str,
    revision: i64,
) -> Result<Value> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let op = get(&mut tx, id, conversation).await?;
    if text(&op, "state") == "applied" {
        return Ok(op["receipt"].clone());
    }
    if text(&op, "state") != "pending" || op["revision"] != revision {
        return Err("操作已暂停、取消或发生变化，请查看最新预览后确认".into());
    }
    let data = load(&mut tx).await?;
    let items = op["preview"].as_array().ok_or("预览数据无效")?;
    for item in items {
        let table = text(item, "table");
        let rid = text(item, "id");
        let current = find(&data, table, rid).cloned().unwrap_or(Value::Null);
        if current != item["before"]
            || effects(&data, table, rid, text(item, "action"))
                != *item["affected"].as_array().ok_or("关联预览无效")?
        {
            return Err(
                "记录或关联内容已在其它页面变化，请重新生成预览；本次未保存任何改动".into(),
            );
        }
    }
    // Revalidate exactly the stored plan; never accept an execution payload from UI/model.
    let (_, verified) = preview(&data, op["actions"].as_array().ok_or("操作数据无效")?)?;
    if verified.len() != items.len() {
        return Err("预览和操作不一致，请重新生成".into());
    }
    for (actual, shown) in verified.iter().zip(items) {
        let clean = |v: &Value| {
            let mut v = v.clone();
            if let Some(obj) = v.as_object_mut() {
                obj.remove("created_at");
                obj.remove("updated_at");
            }
            v
        };
        if actual["id"] != shown["id"]
            || actual["table"] != shown["table"]
            || actual["action"] != shown["action"]
            || clean(&actual["after"]) != clean(&shown["after"])
        {
            return Err("预览和操作不一致，请重新生成".into());
        }
    }
    let applied_at = stamp();
    let mut executed = items.clone();
    for item in &mut executed {
        if !item["after"].is_null() {
            item["after"]["updated_at"] = json!(applied_at);
            if text(item, "action") == "create" {
                item["after"]["created_at"] = json!(applied_at);
            }
            if text(item, "action") == "archive" {
                item["after"]["archived_at"] = json!(applied_at);
            }
            // Completion is a timestamp, unlike calendar dates. Normalize offsets
            // to the same UTC representation used by SQLite exports/imports.
            if let Some(value) = item["after"]["completed_at"].as_str() {
                item["after"]["completed_at"] = json!(DateTime::parse_from_rfc3339(value)
                    .map_err(|_| "执行时间无效")?
                    .with_timezone(&Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
        }
    }
    for item in &executed {
        let table = text(item, "table");
        let fields = columns(table)?;
        if text(item, "action") == "delete" {
            sqlx::query(&format!("DELETE FROM {} WHERE id=?", table))
                .bind(text(item, "id"))
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        } else if text(item, "action") == "create" {
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table,
                fields.join(","),
                vec!["?"; fields.len()].join(",")
            );
            let mut q = sqlx::query(&sql);
            for f in fields {
                q = q.bind(item["after"][*f].as_str());
            }
            q.execute(&mut *tx).await.map_err(|e| e.to_string())?;
        } else {
            let sql = format!(
                "UPDATE {} SET {} WHERE id=?",
                table,
                fields
                    .iter()
                    .filter(|f| **f != "id")
                    .map(|f| format!("{}=?", f))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let mut q = sqlx::query(&sql);
            for f in fields.iter().filter(|f| **f != "id") {
                q = q.bind(item["after"][*f].as_str());
            }
            q.bind(text(item, "id"))
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    let receipt = json!({"operation_id":id,"state":"applied","count":executed.len(),"items":executed.iter().map(|i|json!({"action":i["action"],"table":i["table"],"title":if i["after"].is_null(){i["before"]["title"].clone()}else{i["after"]["title"].clone()},"before":i["before"],"after":i["after"]})).collect::<Vec<_>>(),"applied_at":applied_at});
    sqlx::query("UPDATE assistant_operations SET state='applied',revision=revision+1,receipt=?,updated_at=? WHERE id=?")
        .bind(receipt.to_string()).bind(stamp()).bind(id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(receipt)
}

#[tauri::command]
pub async fn assistant_operations(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<Value>> {
    list(&mut connect(&app).await?, &conversation_id).await
}
#[tauri::command]
pub async fn assistant_presentations(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<Value>> {
    presentations(&mut connect(&app).await?, &conversation_id).await
}
#[tauri::command]
pub async fn assistant_operation_edit(
    app: tauri::AppHandle,
    conversation_id: String,
    id: String,
    revision: i64,
    actions: Vec<Value>,
    title: String,
) -> Result<Value> {
    prepare(
        &mut connect(&app).await?,
        &conversation_id,
        "",
        &title,
        &actions,
        Some((&id, revision)),
    )
    .await
}
#[tauri::command]
pub async fn assistant_operation_transition(
    app: tauri::AppHandle,
    conversation_id: String,
    id: String,
    revision: i64,
    state: String,
) -> Result<Value> {
    transition(
        &mut connect(&app).await?,
        &conversation_id,
        &id,
        revision,
        &state,
    )
    .await
}
#[tauri::command]
pub async fn assistant_operation_apply(
    app: tauri::AppHandle,
    conversation_id: String,
    id: String,
    revision: i64,
) -> Result<Value> {
    apply(&mut connect(&app).await?, &conversation_id, &id, revision).await
}
#[tauri::command]
pub async fn assistant_trace(app: tauri::AppHandle, conversation_id: String) -> Result<Vec<Value>> {
    traces(&mut connect(&app).await?, &conversation_id).await
}
async fn traces(conn: &mut SqliteConnection, conversation_id: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT s.*,r.message_id,r.state AS run_state FROM assistant_steps s JOIN assistant_runs r ON r.id=s.run_id WHERE r.conversation_id=? ORDER BY r.started_at,s.sequence").bind(conversation_id).fetch_all(conn).await.map_err(|e|e.to_string())?;
    rows.iter().map(|r|Ok(json!({"id":r.get::<String,_>("id"),"run_id":r.get::<String,_>("run_id"),"message_id":r.get::<String,_>("message_id"),"tool":r.get::<String,_>("tool"),"label":r.get::<String,_>("label"),"state":if r.get::<String,_>("state")=="running"{"interrupted"}else{r.get::<&str,_>("state")},"result":serde_json::from_str::<Value>(&r.get::<String,_>("result")).map_err(|_|"执行记录无效")?}))).collect()
}
#[tauri::command]
pub async fn assistant_activity(app: tauri::AppHandle, conversation_id: String) -> Result<Value> {
    let mut conn = connect(&app).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result = json!({"ops":list(&mut tx,&conversation_id).await?,"views":presentations(&mut tx,&conversation_id).await?,"trace":traces(&mut tx,&conversation_id).await?});
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
#[path = "assistant_presentation_tests.rs"]
mod presentation_tests;
#[cfg(test)]
#[path = "assistant_operations_tests.rs"]
pub(crate) mod tests;
#[cfg(test)]
#[path = "assistant_validation_tests.rs"]
mod validation_tests;
