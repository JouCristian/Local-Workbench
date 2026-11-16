use serde::Deserialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, QueryBuilder, Row, Sqlite, SqliteConnection};
use std::{collections::HashSet, str::FromStr};
use tauri::Manager;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Complete,
    Reopen,
    Archive,
    Restore,
    Delete,
}

#[tauri::command]
pub async fn batch_tasks(
    app: tauri::AppHandle,
    ids: Vec<String>,
    action: Action,
) -> Result<usize, String> {
    let options = SqliteConnectOptions::from_str("sqlite:")
        .map_err(|e| e.to_string())?
        .filename(
            app.path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join("workbench.db"),
        )
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    apply(&mut conn, &ids, action)
        .await
        .map_err(|e| e.to_string())
}

type Error = Box<dyn std::error::Error + Send + Sync>;
pub async fn apply(
    conn: &mut SqliteConnection,
    ids: &[String],
    action: Action,
) -> Result<usize, Error> {
    if ids.is_empty() || ids.len() > 10000 || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err("请选择 1 至 10000 项不同任务".into());
    }
    let mut tx = conn.begin().await?;
    let mut query=QueryBuilder::<Sqlite>::new("SELECT t.id,t.title,t.project_id,t.stage_id,t.archived_at,p.archived_at AS project_archived FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id IN (");
    {
        let mut list = query.separated(",");
        for id in ids {
            list.push_bind(id);
        }
    }
    query.push(")");
    let rows = query.build().fetch_all(&mut *tx).await?;
    if rows.len() != ids.len() {
        return Err("部分选中任务已被删除，请刷新后重新选择；未执行任何操作".into());
    }
    let stamp: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        .fetch_one(&mut *tx)
        .await?;
    for row in &rows {
        let id: &str = row.try_get("id")?;
        let archived: Option<String> = row.try_get("archived_at")?;
        let parent_archived: Option<String> = row.try_get("project_archived")?;
        if matches!(action, Action::Complete | Action::Reopen)
            && (archived.is_some() || parent_archived.is_some())
        {
            return Err("请先恢复归档任务或所属项目，再更改完成状态；未执行任何操作".into());
        }
        if matches!(action, Action::Restore) {
            if parent_archived.is_some() {
                return Err("请先恢复任务所属的项目".into());
            }
            let title: &str = row.try_get("title")?;
            let project: Option<String> = row.try_get("project_id")?;
            let stage: Option<String> = row.try_get("stage_id")?;
            let conflict:i64=sqlx::query_scalar("SELECT count(*) FROM tasks WHERE id<>? AND archived_at IS NULL AND project_id IS ? AND stage_id IS ? AND lower(replace(replace(replace(trim(title),' ',''),char(9),''),char(12288),''))=lower(replace(replace(replace(trim(?),' ',''),char(9),''),char(12288),''))").bind(id).bind(project).bind(stage).bind(title).fetch_one(&mut *tx).await?;
            if conflict > 0 {
                return Err(
                    "恢复后将出现同分类、同阶段的同名任务，请先处理冲突；全部改动已回滚".into(),
                );
            }
        }
        match action {
            Action::Delete => {
                sqlx::query("DELETE FROM tasks WHERE id=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            Action::Complete | Action::Reopen => {
                sqlx::query("UPDATE tasks SET status=?,updated_at=? WHERE id=?")
                    .bind(if matches!(action, Action::Complete) {
                        "done"
                    } else {
                        "todo"
                    })
                    .bind(&stamp)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            Action::Archive | Action::Restore => {
                sqlx::query("UPDATE tasks SET archived_at=?,updated_at=? WHERE id=?")
                    .bind(if matches!(action, Action::Archive) {
                        Some(stamp.as_str())
                    } else {
                        None
                    })
                    .bind(&stamp)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(ids.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_integrity.sql"),
            include_str!("../migrations/003_preserve_tasks.sql"),
            include_str!("../migrations/004_archives.sql"),
            include_str!("../migrations/005_project_delete_contents.sql"),
            include_str!("../migrations/006_task_delete_schedules.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql("INSERT INTO tasks(id,title,notes,status,priority,created_at,updated_at) VALUES ('a','A','','todo','medium','now','now'),('b','B','','doing','medium','now','now');INSERT INTO schedules VALUES ('plan','a','Plan','2026-11-13','morning',NULL,NULL,'','now','now');").execute(&mut conn).await.unwrap();
        conn
    }
    #[test]
    fn complete_archive_restore_and_delete_are_atomic() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            let ids = vec!["a".into(), "b".into()];
            apply(&mut c, &ids, Action::Complete).await.unwrap();
            apply(&mut c, &ids, Action::Archive).await.unwrap();
            apply(&mut c, &ids, Action::Restore).await.unwrap();
            let done: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM tasks WHERE status='done' AND archived_at IS NULL",
            )
            .fetch_one(&mut c)
            .await
            .unwrap();
            assert_eq!(done, 2);
            apply(&mut c, &ids, Action::Reopen).await.unwrap();
            apply(&mut c, &ids, Action::Delete).await.unwrap();
            let plans: i64 = sqlx::query_scalar("SELECT count(*) FROM schedules")
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert_eq!(plans, 0);
        });
    }
    #[test]
    fn failure_rolls_back_the_whole_selection() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            sqlx::raw_sql("CREATE TRIGGER block_b BEFORE DELETE ON tasks WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT,'blocked');END;").execute(&mut c).await.unwrap();
            assert!(apply(&mut c, &["a".into(), "b".into()], Action::Delete)
                .await
                .is_err());
            let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
                .fetch_one(&mut c)
                .await
                .unwrap();
            let plans: i64 = sqlx::query_scalar("SELECT count(*) FROM schedules")
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert_eq!(tasks, 2);
            assert_eq!(plans, 1);
            assert!(
                apply(&mut c, &["a".into(), "missing".into()], Action::Complete)
                    .await
                    .is_err()
            );
            let status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id='a'")
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert_eq!(status, "todo");
        });
    }
    #[test]
    fn restore_conflicts_roll_back_previous_updates() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            sqlx::raw_sql("UPDATE tasks SET title='Same',archived_at='archived';")
                .execute(&mut c)
                .await
                .unwrap();
            assert!(apply(&mut c, &["a".into(), "b".into()], Action::Restore)
                .await
                .is_err());
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM tasks WHERE archived_at IS NOT NULL")
                    .fetch_one(&mut c)
                    .await
                    .unwrap();
            assert_eq!(count, 2);
        });
    }
}
