mod assistant;
mod assistant_operations;
mod assistant_tools;
mod schedule_completion;
mod task_batch;
mod task_schedules;
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

const TABLES: &[(&str, &[&str])] = &[
    (
        "projects",
        &[
            "id",
            "title",
            "notes",
            "created_at",
            "updated_at",
            "archived_at",
        ],
    ),
    (
        "stages",
        &[
            "id",
            "project_id",
            "title",
            "start_date",
            "end_date",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "tasks",
        &[
            "id",
            "title",
            "notes",
            "status",
            "priority",
            "due_date",
            "due_time",
            "project_id",
            "stage_id",
            "archived_at",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "schedules",
        &[
            "id",
            "task_id",
            "title",
            "date",
            "period",
            "start_time",
            "end_time",
            "notes",
            "created_at",
            "updated_at",
            "completed_at",
        ],
    ),
    (
        "events",
        &[
            "id",
            "title",
            "date",
            "kind",
            "notes",
            "created_at",
            "updated_at",
        ],
    ),
];

#[tauri::command]
fn data_directory(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// Uses one SQLite connection/transaction. A JS-side BEGIN on a connection pool is unsafe.
#[tauri::command]
async fn restore_snapshot(app: tauri::AppHandle, snapshot: Value) -> Result<String, String> {
    restore_inner(app, snapshot)
        .await
        .map_err(|e| e.to_string())
}

async fn restore_inner(
    app: tauri::AppHandle,
    snapshot: Value,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    validate_snapshot(&snapshot)?;
    let dir = app.path().app_config_dir()?;
    let options = SqliteConnectOptions::from_str("sqlite:")?
        .filename(dir.join("workbench.db"))
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options).await?;
    let mut tx = conn.begin().await?;
    let exported_at: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        .fetch_one(&mut *tx)
        .await?;
    let mut old = json!({"format":"local-workbench","version":1,"exported_at":exported_at});
    for (table, columns) in TABLES {
        let rows = sqlx::query(&format!("SELECT {} FROM {}", columns.join(","), table))
            .fetch_all(&mut *tx)
            .await?;
        let mut values = Vec::new();
        for row in rows {
            let mut object = serde_json::Map::new();
            for col in *columns {
                object.insert(
                    (*col).to_string(),
                    row.try_get::<Option<String>, _>(*col)?
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
            }
            values.push(Value::Object(object));
        }
        old[*table] = Value::Array(values);
    }
    let backup_dir = dir.join("backups");
    std::fs::create_dir_all(&backup_dir)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let backup_path = backup_dir.join(format!("before-restore-{}.json", stamp));
    std::fs::write(&backup_path, serde_json::to_vec_pretty(&old)?)?;
    replace_rows(&mut tx, &snapshot).await?;
    tx.commit().await?;
    Ok(backup_path.to_string_lossy().to_string())
}

fn validate_snapshot(snapshot: &Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if snapshot["format"] != "local-workbench" || snapshot["version"] != 1 {
        return Err("Unsupported backup format".into());
    }
    for (table, columns) in TABLES {
        let rows = snapshot[*table].as_array().ok_or("Missing data table")?;
        if rows.len() > 100_000 {
            return Err("Backup has too many records".into());
        }
        for row in rows {
            if !row.is_object()
                || columns.iter().any(|c| {
                    (*c != "archived_at" && *c != "completed_at" && row.get(*c).is_none())
                        || (!row[*c].is_string() && !row[*c].is_null())
                })
            {
                return Err("Invalid record fields".into());
            }
        }
    }
    Ok(())
}
async fn replace_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    snapshot: &Value,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    for table in ["schedules", "tasks", "events", "stages", "projects"] {
        sqlx::query(&format!("DELETE FROM {}", table))
            .execute(&mut **tx)
            .await?;
    }
    for (table, columns) in TABLES {
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            columns.join(","),
            vec!["?"; columns.len()].join(",")
        );
        for row in snapshot[*table].as_array().ok_or("Invalid table")? {
            let mut query = sqlx::query(&sql);
            for col in *columns {
                query = query.bind(row[*col].as_str());
            }
            query.execute(&mut **tx).await?;
        }
    }
    if !sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut **tx)
        .await?
        .is_empty()
    {
        return Err("Backup contains broken relationships".into());
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(assistant::Requests::default())
        .manage(assistant::voice::VoiceState::default())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:workbench.db",
                    vec![
                        Migration {
                            version: 1,
                            description: "initial_schema",
                            sql: include_str!("../migrations/001_initial.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 2,
                            description: "relationship_integrity",
                            sql: include_str!("../migrations/002_integrity.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 3,
                            description: "preserve_tasks_on_project_delete",
                            sql: include_str!("../migrations/003_preserve_tasks.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 4,
                            description: "archives",
                            sql: include_str!("../migrations/004_archives.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 5,
                            description: "project_delete_contents",
                            sql: include_str!("../migrations/005_project_delete_contents.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 6,
                            description: "task_delete_schedules",
                            sql: include_str!("../migrations/006_task_delete_schedules.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 7,
                            description: "assistant_history",
                            sql: include_str!("../migrations/007_assistant.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 8,
                            description: "schedule_completion",
                            sql: include_str!("../migrations/008_schedule_completion.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 9,
                            description: "conversation_preferences",
                            sql: include_str!("../migrations/009_conversation_preferences.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 10,
                            description: "assistant_agent",
                            sql: include_str!("../migrations/010_assistant_agent.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 11,
                            description: "agent_runtime",
                            sql: include_str!("../migrations/011_agent_runtime.sql"),
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 12,
                            description: "operation_presentations",
                            sql: include_str!("../migrations/012_operation_presentations.sql"),
                            kind: MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            restore_snapshot,
            data_directory,
            task_batch::batch_tasks,
            task_schedules::save_task_schedules,
            assistant::assistant_key_status,
            assistant::voice::assistant_voice_start,
            assistant::voice::assistant_voice_finish,
            assistant::voice::assistant_voice_cancel,
            assistant::assistant_save_key,
            assistant::assistant_delete_key,
            assistant::assistant_test_connection,
            assistant::assistant_chat,
            assistant::assistant_cancel,
            assistant::assistant_attachment,
            assistant::assistant_apply,
            assistant_operations::assistant_operations,
            assistant_operations::assistant_presentations,
            assistant_operations::assistant_activity,
            assistant_operations::assistant_operation_edit,
            assistant_operations::assistant_operation_transition,
            assistant_operations::assistant_operation_apply,
            assistant_operations::assistant_trace,
            schedule_completion::set_schedule_completion
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start Local Workbench");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_preserves_archives_and_accepts_legacy_json() {
        tauri::async_runtime::block_on(async {
            let legacy: Value =
                serde_json::from_str(include_str!("../../examples/generic.json")).unwrap();
            validate_snapshot(&legacy).unwrap();
            let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            for sql in [
                include_str!("../migrations/001_initial.sql"),
                include_str!("../migrations/002_integrity.sql"),
                include_str!("../migrations/003_preserve_tasks.sql"),
                include_str!("../migrations/004_archives.sql"),
                include_str!("../migrations/005_project_delete_contents.sql"),
                include_str!("../migrations/006_task_delete_schedules.sql"),
                include_str!("../migrations/008_schedule_completion.sql"),
            ] {
                sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
            }
            let mut archived = legacy.clone();
            archived["projects"][0]["archived_at"] = json!("2026-11-13T00:00:00Z");
            archived["tasks"][0]["archived_at"] = json!("2026-11-13T00:00:00Z");
            archived["tasks"][0]["status"] = json!("done");
            archived["schedules"][0]["completed_at"] = json!("2026-11-13T12:00:00Z");
            validate_snapshot(&archived).unwrap();
            let mut tx = conn.begin().await.unwrap();
            replace_rows(&mut tx, &archived).await.unwrap();
            tx.commit().await.unwrap();
            let row = sqlx::query("SELECT status,archived_at FROM tasks WHERE id=?")
                .bind(archived["tasks"][0]["id"].as_str())
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(row.get::<String, _>("status"), "done");
            assert_eq!(row.get::<String, _>("archived_at"), "2026-11-13T00:00:00Z");
            let completed: Option<String> =
                sqlx::query_scalar("SELECT completed_at FROM schedules WHERE id=?")
                    .bind(archived["schedules"][0]["id"].as_str())
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(completed.as_deref(), Some("2026-11-13T12:00:00Z"));
            let mut tx = conn.begin().await.unwrap();
            replace_rows(&mut tx, &legacy).await.unwrap();
            tx.commit().await.unwrap();
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM tasks WHERE archived_at IS NOT NULL")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }
    #[test]
    fn invalid_restore_rolls_back() {
        tauri::async_runtime::block_on(async {
            let legacy: Value =
                serde_json::from_str(include_str!("../../examples/generic.json")).unwrap();
            let mut conn = SqliteConnection::connect_with(
                &SqliteConnectOptions::from_str("sqlite::memory:")
                    .unwrap()
                    .foreign_keys(true),
            )
            .await
            .unwrap();
            for sql in [
                include_str!("../migrations/001_initial.sql"),
                include_str!("../migrations/002_integrity.sql"),
                include_str!("../migrations/003_preserve_tasks.sql"),
                include_str!("../migrations/004_archives.sql"),
                include_str!("../migrations/005_project_delete_contents.sql"),
                include_str!("../migrations/006_task_delete_schedules.sql"),
                include_str!("../migrations/008_schedule_completion.sql"),
            ] {
                sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
            }
            let mut tx = conn.begin().await.unwrap();
            replace_rows(&mut tx, &legacy).await.unwrap();
            tx.commit().await.unwrap();
            let mut bad = legacy.clone();
            bad["tasks"][0]["project_id"] = json!("missing-project");
            let mut tx = conn.begin().await.unwrap();
            assert!(replace_rows(&mut tx, &bad).await.is_err());
            tx.rollback().await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(count, legacy["tasks"].as_array().unwrap().len() as i64);
        });
    }
}
