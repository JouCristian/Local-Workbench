use super::*;

pub async fn database() -> SqliteConnection {
    let mut c = SqliteConnection::connect_with(
        &SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true),
    )
    .await
    .unwrap();
    migrate(&mut c).await;
    c
}
pub async fn migrate(c: &mut SqliteConnection) {
    for sql in [
        include_str!("../migrations/001_initial.sql"),
        include_str!("../migrations/002_integrity.sql"),
        include_str!("../migrations/003_preserve_tasks.sql"),
        include_str!("../migrations/004_archives.sql"),
        include_str!("../migrations/005_project_delete_contents.sql"),
        include_str!("../migrations/006_task_delete_schedules.sql"),
        include_str!("../migrations/007_assistant.sql"),
        include_str!("../migrations/008_schedule_completion.sql"),
        include_str!("../migrations/009_conversation_preferences.sql"),
        include_str!("../migrations/010_assistant_agent.sql"),
        include_str!("../migrations/011_agent_runtime.sql"),
        include_str!("../migrations/012_operation_presentations.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&mut *c).await.unwrap();
    }
}
pub const CONV: &str = "00000000-0000-4000-8000-000000000001";
pub async fn conversation(c: &mut SqliteConnection) {
    sqlx::query(
        "INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES (?,'test',?,?)",
    )
    .bind(CONV)
    .bind(stamp())
    .bind(stamp())
    .execute(c)
    .await
    .unwrap();
}
pub async fn seed(c: &mut SqliteConnection) -> Value {
    conversation(c).await;
    let op=prepare(c,CONV,"msg","新建项目与任务",&[
        json!({"key":"p","ref":"p","table":"projects","action":"create","fields":{"title":"项目"}}),
        json!({"key":"stage","ref":"stage","table":"stages","action":"create","fields":{"title":"阶段","project_id":"p","start_date":"2026-11-12","end_date":"2026-11-20"}}),
        json!({"key":"a","ref":"a","table":"tasks","action":"create","fields":{"title":"任务甲","project_id":"p","stage_id":"stage","due_date":"2026-11-15","due_time":"23:59"}}),
        json!({"key":"b","ref":"b","table":"tasks","action":"create","fields":{"title":"任务乙","due_date":"2026-11-15","due_time":"23:59"}}),
        json!({"key":"s","table":"schedules","action":"create","fields":{"title":"执行甲","task_id":"a","date":"2026-11-13","period":"afternoon","completed_at":"2026-11-15T08:48:00Z"}})
    ],None).await.unwrap();
    apply(c, CONV, text(&op, "id"), 0).await.unwrap();
    load(c).await.unwrap()
}
#[test]
fn batch_deadline_shift_preserves_completed_history_and_is_atomic() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        let actions=rows(&data,"tasks").iter().enumerate().map(|(i,t)|json!({"key":i.to_string(),"table":"tasks","action":"update","id":t["id"],"shift_due_days":2})).collect::<Vec<_>>();
        let op = prepare(&mut c, CONV, "msg2", "顺延两项任务", &actions, None)
            .await
            .unwrap();
        assert_eq!(load(&mut c).await.unwrap(), data);
        for p in op["preview"].as_array().unwrap() {
            assert_eq!(p["after"]["due_date"], "2026-11-17");
            assert_eq!(p["after"]["due_time"], "23:59");
        }
        let receipt = apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap();
        assert_eq!(receipt["count"], 2);
        let final_data = load(&mut c).await.unwrap();
        assert_eq!(final_data["schedules"], data["schedules"]);
        assert_eq!(
            apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap(),
            receipt
        );
        let next = prepare(&mut c, CONV, "m3", "再调整", &actions, None)
            .await
            .unwrap();
        sqlx::query("UPDATE tasks SET notes='changed' WHERE id=?")
            .bind(text(&data["tasks"][0], "id"))
            .execute(&mut c)
            .await
            .unwrap();
        let before = load(&mut c).await.unwrap();
        assert!(apply(&mut c, CONV, text(&next, "id"), 0).await.is_err());
        assert_eq!(load(&mut c).await.unwrap(), before);
    });
}
#[test]
fn pause_cancel_revision_and_cross_conversation_are_enforced() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op=prepare(&mut c,CONV,"m","事件",&[json!({"key":"e","table":"events","action":"create","fields":{"title":"休息","date":"2026-11-18","kind":"rest"}})],None).await.unwrap();
        let id = text(&op, "id");
        transition(&mut c, CONV, id, 0, "paused").await.unwrap();
        assert!(apply(&mut c, CONV, id, 1).await.is_err());
        assert!(transition(&mut c, CONV, id, 0, "pending").await.is_err());
        assert!(get(&mut c, id, "other").await.is_err());
        transition(&mut c, CONV, id, 1, "pending").await.unwrap();
        transition(&mut c, CONV, id, 2, "cancelled").await.unwrap();
        assert!(apply(&mut c, CONV, id, 3).await.is_err());
        assert!(rows(&load(&mut c).await.unwrap(), "events").is_empty());
    });
}
#[test]
fn deletion_previews_cascade_and_detects_new_children() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        let project = &data["projects"][0];
        let op = prepare(
            &mut c,
            CONV,
            "m",
            "删除项目",
            &[json!({"key":"p","table":"projects","action":"delete","id":project["id"]})],
            None,
        )
        .await
        .unwrap();
        assert_eq!(op["preview"][0]["affected"].as_array().unwrap().len(), 4);
        sqlx::query("UPDATE schedules SET notes='new note'")
            .execute(&mut c)
            .await
            .unwrap();
        assert!(apply(&mut c, CONV, text(&op, "id"), 0).await.is_err());
        let op = prepare(
            &mut c,
            CONV,
            "m",
            "删除项目",
            op["actions"].as_array().unwrap(),
            Some((text(&op, "id"), 0)),
        )
        .await
        .unwrap();
        apply(&mut c, CONV, text(&op, "id"), 1).await.unwrap();
        let after = load(&mut c).await.unwrap();
        assert_eq!(rows(&after, "tasks").len(), 1);
        assert!(rows(&after, "schedules").is_empty());
        assert!(rows(&after, "stages").is_empty());
    });
}
#[test]
fn invalid_dates_duplicates_and_implicit_fuzzy_hours_are_rejected() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        for action in [
            json!({"key":"e","table":"events","action":"create","fields":{"title":"无效","date":"2026-02-30","kind":"event"}}),
            json!({"key":"s","table":"schedules","action":"create","fields":{"title":"无效","date":"2026-11-18","period":"morning","start_time":"08:00"}}),
            json!({"key":"b","table":"tasks","action":"create","fields":{"title":"任务乙"}}),
        ] {
            assert!(prepare(&mut c, CONV, "m", "无效", &[action], None)
                .await
                .is_err());
        }
        assert_eq!(load(&mut c).await.unwrap(), data);
    });
}

#[test]
fn project_archive_restore_and_stage_delete_preserve_task_history() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        let pid = data["projects"][0]["id"].clone();
        for action in ["archive", "restore"] {
            let op = prepare(
                &mut c,
                CONV,
                "m",
                action,
                &[json!({"key":"p","table":"projects","action":action,"id":pid})],
                None,
            )
            .await
            .unwrap();
            apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap();
            assert_eq!(load(&mut c).await.unwrap()["tasks"], data["tasks"]);
            assert_eq!(load(&mut c).await.unwrap()["schedules"], data["schedules"]);
        }
        let op = prepare(
            &mut c,
            CONV,
            "m",
            "删除阶段",
            &[json!({"key":"s","table":"stages","action":"delete","id":data["stages"][0]["id"]})],
            None,
        )
        .await
        .unwrap();
        assert_eq!(op["preview"][0]["affected"].as_array().unwrap().len(), 2);
        apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap();
        let after = load(&mut c).await.unwrap();
        assert_eq!(rows(&after, "tasks").len(), 2);
        assert_eq!(after["schedules"], data["schedules"]);
        assert!(rows(&after, "tasks")
            .iter()
            .all(|t| t["stage_id"].is_null()));
    });
}

#[test]
fn a_late_database_failure_rolls_back_earlier_steps() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        let actions=rows(&data,"tasks").iter().enumerate().map(|(i,t)|json!({"key":i.to_string(),"table":"tasks","action":"update","id":t["id"],"fields":{"status":"doing"}})).collect::<Vec<_>>();
        let op = prepare(&mut c, CONV, "m", "整批更新", &actions, None)
            .await
            .unwrap();
        sqlx::raw_sql(&format!("CREATE TRIGGER reject_second BEFORE UPDATE ON tasks WHEN NEW.id='{}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",text(&data["tasks"][1],"id"))).execute(&mut c).await.unwrap();
        assert!(apply(&mut c, CONV, text(&op, "id"), 0).await.is_err());
        assert_eq!(load(&mut c).await.unwrap(), data);
        assert_eq!(
            get(&mut c, text(&op, "id"), CONV).await.unwrap()["state"],
            "pending"
        );
    });
}

#[test]
fn pending_operation_survives_a_closed_and_reopened_sqlite_file() {
    tauri::async_runtime::block_on(async {
        let path = std::env::temp_dir().join(format!(
            "local-workbench-agent-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut c = SqliteConnection::connect_with(
            &SqliteConnectOptions::from_str("sqlite:")
                .unwrap()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
        migrate(&mut c).await;
        let data = seed(&mut c).await;
        let op=prepare(&mut c,CONV,"m","等待重启",&[json!({"key":"a","table":"tasks","action":"update","id":data["tasks"][0]["id"],"shift_due_days":2})],None).await.unwrap();
        c.close().await.unwrap();
        let mut reopened = SqliteConnection::connect_with(
            &SqliteConnectOptions::from_str("sqlite:")
                .unwrap()
                .filename(&path)
                .foreign_keys(true),
        )
        .await
        .unwrap();
        assert_eq!(get(&mut reopened, text(&op, "id"), CONV).await.unwrap(), op);
        let receipt = apply(&mut reopened, CONV, text(&op, "id"), 0)
            .await
            .unwrap();
        assert_eq!(receipt["count"], 1);
        reopened.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    });
}

#[test]
fn duplicate_pending_groups_and_extreme_offsets_cannot_escape_validation() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let data = seed(&mut c).await;
        let mut action = json!({"key":"a","table":"tasks","action":"update","id":data["tasks"][0]["id"],"shift_due_days":2});
        let op = prepare(&mut c, CONV, "m", "第一组", &[action.clone()], None)
            .await
            .unwrap();
        assert!(
            prepare(&mut c, CONV, "m", "重复组", &[action.clone()], None)
                .await
                .is_err()
        );
        transition(&mut c, CONV, text(&op, "id"), 0, "cancelled")
            .await
            .unwrap();
        action["shift_due_days"] = json!(i64::MIN);
        assert!(prepare(&mut c, CONV, "m", "越界", &[action], None)
            .await
            .is_err());
        assert_eq!(load(&mut c).await.unwrap(), data);
    });
}
