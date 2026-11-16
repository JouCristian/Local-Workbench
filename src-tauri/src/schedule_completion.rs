use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{str::FromStr, time::Duration};
use tauri::Manager;

#[tauri::command]
pub async fn set_schedule_completion(
    app: tauri::AppHandle,
    id: String,
    completed: bool,
    expected_updated_at: String,
    expected_task_id: Option<String>,
    complete_task: bool,
    expected_task_updated_at: Option<String>,
) -> Result<(), String> {
    let options = SqliteConnectOptions::from_str("sqlite:")
        .map_err(|e| e.to_string())?
        .filename(
            app.path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join("workbench.db"),
        )
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    apply(
        &mut conn,
        &id,
        completed,
        &expected_updated_at,
        expected_task_id.as_deref(),
        complete_task,
        expected_task_updated_at.as_deref(),
    )
    .await
}
pub async fn apply(
    conn: &mut SqliteConnection,
    id: &str,
    completed: bool,
    revision: &str,
    expected_task_id: Option<&str>,
    complete_task: bool,
    task_revision: Option<&str>,
) -> Result<(), String> {
    if complete_task && !completed {
        return Err("重新打开日程不会修改任务状态".into());
    }
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT updated_at,task_id FROM schedules WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("这条日程已删除，请刷新后重试")?;
    let task_id: Option<String> = row.get("task_id");
    if row.get::<&str, _>("updated_at") != revision || task_id.as_deref() != expected_task_id {
        return Err("日程已发生变化，本次未保存，请刷新后重试".into());
    }
    let stamp: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if complete_task {
        let task = task_id.as_deref().ok_or("独立日程没有关联任务")?;
        let result=sqlx::query("UPDATE tasks SET status='done',updated_at=? WHERE id=? AND updated_at=? AND archived_at IS NULL AND (project_id IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=tasks.project_id AND archived_at IS NULL))")
            .bind(&stamp).bind(task).bind(task_revision).execute(&mut *tx).await.map_err(|e|e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("关联任务已改变或归档，本次未保存，请刷新后重试".into());
        }
    }
    sqlx::query("UPDATE schedules SET completed_at=?,updated_at=? WHERE id=?")
        .bind(if completed { Some(&stamp) } else { None })
        .bind(&stamp)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/004_archives.sql"),
            include_str!("../migrations/008_schedule_completion.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql("INSERT INTO tasks(id,title,status,priority,created_at,updated_at) VALUES ('task','Task','todo','medium','now','now'); INSERT INTO schedules(id,task_id,title,date,period,created_at,updated_at) VALUES ('a','task','A','2026-11-15','morning','now','now'),('b','task','B','2026-11-16','afternoon','now','now'),('c','task','C','2026-11-17','evening','now','now');").execute(&mut conn).await.unwrap();
        conn
    }
    #[test]
    fn execution_completion_does_not_finish_task_or_other_schedules() {
        tauri::async_runtime::block_on(async {
            let mut conn = fixture().await;
            apply(&mut conn, "a", true, "now", Some("task"), false, None)
                .await
                .unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id='task'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(status, "todo");
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM schedules WHERE completed_at IS NOT NULL")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 1);
            let updated: String =
                sqlx::query_scalar("SELECT updated_at FROM schedules WHERE id='a'")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            apply(&mut conn, "a", false, &updated, Some("task"), false, None)
                .await
                .unwrap();
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM schedules WHERE completed_at IS NOT NULL")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }
    #[test]
    fn explicit_task_completion_is_atomic_and_reopen_leaves_task_done() {
        tauri::async_runtime::block_on(async {
            let mut conn = fixture().await;
            assert!(apply(
                &mut conn,
                "a",
                true,
                "now",
                Some("task"),
                true,
                Some("stale")
            )
            .await
            .is_err());
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM schedules WHERE completed_at IS NOT NULL")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
            apply(&mut conn, "a", true, "now", Some("task"), true, Some("now"))
                .await
                .unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id='task'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(status, "done");
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM schedules WHERE completed_at IS NOT NULL")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 1);
            let updated: String =
                sqlx::query_scalar("SELECT updated_at FROM schedules WHERE id='a'")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            apply(&mut conn, "a", false, &updated, Some("task"), false, None)
                .await
                .unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id='task'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(status, "done");
        });
    }
    #[test]
    fn single_or_unlinked_schedule_remains_independent_and_stale_writes_fail() {
        tauri::async_runtime::block_on(async {
            let mut conn = fixture().await;
            sqlx::query("DELETE FROM schedules WHERE id IN ('b','c')")
                .execute(&mut conn)
                .await
                .unwrap();
            apply(&mut conn, "a", true, "now", Some("task"), false, None)
                .await
                .unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id='task'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(status, "todo");
            assert!(
                apply(&mut conn, "a", false, "stale", Some("task"), false, None)
                    .await
                    .is_err()
            );
            sqlx::query("INSERT INTO schedules(id,title,date,period,created_at,updated_at) VALUES ('solo','Solo','2026-11-15','anytime','now','now')").execute(&mut conn).await.unwrap();
            apply(&mut conn, "solo", true, "now", None, false, None)
                .await
                .unwrap();
        });
    }
}
