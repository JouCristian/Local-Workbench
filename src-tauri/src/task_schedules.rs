use serde::Deserialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};
use tauri::Manager;

#[derive(Clone, Deserialize)]
pub struct Plan {
    id: String,
    task_id: Option<String>,
    title: String,
    date: String,
    period: String,
    start_time: Option<String>,
    end_time: Option<String>,
    notes: String,
    created_at: String,
    updated_at: String,
}
#[derive(Deserialize)]
pub struct Revision {
    id: String,
    updated_at: String,
}
type Error = Box<dyn std::error::Error + Send + Sync>;

#[tauri::command]
pub async fn save_task_schedules(
    app: tauri::AppHandle,
    task_id: String,
    plans: Vec<Plan>,
    expected: Vec<Revision>,
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
    apply(&mut conn, &task_id, &plans, &expected)
        .await
        .map_err(|e| e.to_string())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    task: &str,
    plans: &[Plan],
    expected: &[Revision],
) -> Result<usize, Error> {
    if plans.len() > 10000 || expected.len() > 10000 {
        return Err("一次最多管理10000条日程".into());
    }
    let mut ids = HashSet::new();
    let mut slots = HashSet::new();
    let mut tx = conn.begin().await?;
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.archived_at IS NULL AND p.archived_at IS NULL")
        .bind(task).fetch_one(&mut *tx).await?;
    if active != 1 {
        return Err("任务已删除或归档，请关闭窗口后重新选择".into());
    }
    let current = sqlx::query("SELECT id,updated_at,completed_at FROM schedules WHERE task_id=?")
        .bind(task)
        .fetch_all(&mut *tx)
        .await?;
    let revisions: HashMap<&str, &str> = expected
        .iter()
        .map(|r| (r.id.as_str(), r.updated_at.as_str()))
        .collect();
    if revisions.len() != expected.len()
        || current.len() != expected.len()
        || current.iter().any(|r| {
            revisions.get(r.get::<&str, _>("id")).copied() != Some(r.get::<&str, _>("updated_at"))
        })
    {
        return Err("这些日程已在其他位置改变，本次未保存。请关闭并重新打开后再编辑".into());
    }
    for plan in plans {
        let normalized: Option<String> = sqlx::query_scalar("SELECT date(?,'+0 days')")
            .bind(&plan.date)
            .fetch_one(&mut *tx)
            .await?;
        let time_ok = |time: &str| -> bool {
            let bytes = time.as_bytes();
            bytes.len() == 5
                && bytes[2] == b':'
                && bytes[0..2]
                    .iter()
                    .chain(bytes[3..5].iter())
                    .all(u8::is_ascii_digit)
                && &time[0..2] < "24"
                && &time[3..5] < "60"
        };
        if plan.task_id.as_deref() != Some(task)
            || plan.id.is_empty()
            || !ids.insert(&plan.id)
            || plan.title.trim().is_empty()
            || plan.title.chars().count() > 300
            || plan.notes.chars().count() > 20000
            || normalized.as_deref() != Some(plan.date.as_str())
            || plan.date.len() != 10
            || plan.date.as_str() < "1900-01-01"
            || !["anytime", "morning", "afternoon", "evening", "exact"]
                .contains(&plan.period.as_str())
            || (plan.period == "exact" && plan.start_time.is_none())
            || (plan.period != "exact" && (plan.start_time.is_some() || plan.end_time.is_some()))
            || plan.start_time.as_deref().is_some_and(|t| !time_ok(t))
            || plan.end_time.as_deref().is_some_and(|t| !time_ok(t))
            || (plan.end_time.is_some() && plan.end_time <= plan.start_time)
        {
            return Err("日程字段无效，请检查标题、日期及开始结束时间；未保存任何改动".into());
        }
        if !slots.insert((&plan.date, &plan.period, &plan.start_time)) {
            return Err("同一任务在相同日期、时段和开始时间已有安排，请合并或调整时间".into());
        }
        let owner: Option<String> =
            sqlx::query_scalar("SELECT coalesce(task_id,'') FROM schedules WHERE id=?")
                .bind(&plan.id)
                .fetch_optional(&mut *tx)
                .await?;
        if owner.as_deref().is_some_and(|id| id != task) {
            return Err("日程不属于当前任务；未保存任何改动".into());
        }
    }
    let completions: HashMap<String, Option<String>> = current
        .iter()
        .map(|row| (row.get("id"), row.get("completed_at")))
        .collect();
    // Replace only this task's plans inside one transaction, so swapping two times
    // is valid and a failed insertion restores every original row.
    sqlx::query("DELETE FROM schedules WHERE task_id=?")
        .bind(task)
        .execute(&mut *tx)
        .await?;
    for p in plans {
        sqlx::query("INSERT INTO schedules(id,task_id,title,date,period,start_time,end_time,notes,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&p.id).bind(task).bind(&p.title).bind(&p.date).bind(&p.period).bind(&p.start_time).bind(&p.end_time)
            .bind(&p.notes).bind(&p.created_at).bind(&p.updated_at).bind(completions.get(&p.id).cloned().flatten()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(plans.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> SqliteConnection {
        let mut c = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/004_archives.sql"),
            include_str!("../migrations/008_schedule_completion.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut c).await.unwrap();
        }
        sqlx::raw_sql("INSERT INTO tasks(id,title,notes,status,priority,created_at,updated_at) VALUES ('task','Task','','todo','medium','now','now'); INSERT INTO schedules(id,task_id,title,date,period,start_time,end_time,notes,created_at,updated_at) VALUES ('a','task','A','2026-11-13','morning',NULL,NULL,'','now','now');").execute(&mut c).await.unwrap();
        c
    }
    fn plan(id: &str, period: &str) -> Plan {
        Plan {
            id: id.into(),
            task_id: Some("task".into()),
            title: id.into(),
            date: "2026-11-13".into(),
            period: period.into(),
            start_time: None,
            end_time: None,
            notes: "".into(),
            created_at: "now".into(),
            updated_at: "later".into(),
        }
    }
    fn revision() -> Vec<Revision> {
        vec![Revision {
            id: "a".into(),
            updated_at: "now".into(),
        }]
    }
    #[test]
    fn saves_multiple_and_preserves_task() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            sqlx::query("UPDATE schedules SET completed_at='2026-11-13T12:00:00Z' WHERE id='a'")
                .execute(&mut c)
                .await
                .unwrap();
            assert_eq!(
                apply(
                    &mut c,
                    "task",
                    &[plan("a", "afternoon"), plan("b", "morning")],
                    &revision()
                )
                .await
                .unwrap(),
                2
            );
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert_eq!(n, 1);
            let completed: Option<String> =
                sqlx::query_scalar("SELECT completed_at FROM schedules WHERE id='a'")
                    .fetch_one(&mut c)
                    .await
                    .unwrap();
            assert_eq!(completed.as_deref(), Some("2026-11-13T12:00:00Z"));
        });
    }
    #[test]
    fn rejects_duplicates_invalid_dates_and_stale_revisions() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            assert!(apply(
                &mut c,
                "task",
                &[plan("a", "morning"), plan("b", "morning")],
                &revision()
            )
            .await
            .is_err());
            let mut bad = plan("a", "morning");
            bad.date = "2026-02-30".into();
            assert!(apply(&mut c, "task", &[bad], &revision()).await.is_err());
            assert!(apply(&mut c, "task", &[], &[]).await.is_err());
            let n: i64 =
                sqlx::query_scalar("SELECT count(*) FROM schedules WHERE updated_at='now'")
                    .fetch_one(&mut c)
                    .await
                    .unwrap();
            assert_eq!(n, 1);
        });
    }
    #[test]
    fn failed_insert_restores_all_original_plans() {
        tauri::async_runtime::block_on(async {
            let mut c = fixture().await;
            sqlx::raw_sql("CREATE TRIGGER fail_b BEFORE INSERT ON schedules WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'blocked'); END;").execute(&mut c).await.unwrap();
            assert!(apply(
                &mut c,
                "task",
                &[plan("a", "afternoon"), plan("b", "evening")],
                &revision()
            )
            .await
            .is_err());
            let period: String = sqlx::query_scalar("SELECT period FROM schedules WHERE id='a'")
                .fetch_one(&mut c)
                .await
                .unwrap();
            assert_eq!(period, "morning");
        });
    }
}
