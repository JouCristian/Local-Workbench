use super::tests::{conversation, database, CONV};
use super::*;
fn book() -> Value {
    json!({"key":"book","table":"tasks","action":"create","fields":{"title":"[验收] 整理书架","priority":"low","notes":"手动备注必须保留"}})
}

#[test]
fn redisplay_and_manual_edit_preserve_identity_revision_state_and_original_anchor() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op = prepare(&mut c, CONV, "first", "整理书架", &[book()], None)
            .await
            .unwrap();
        let id = text(&op, "id");
        let original = get(&mut c, id, CONV).await.unwrap();
        present(&mut c, CONV, id, 0, "latest").await.unwrap();
        present(&mut c, CONV, id, 0, "latest").await.unwrap();
        assert_eq!(get(&mut c, id, CONV).await.unwrap(), original);
        assert_eq!(presentations(&mut c, CONV).await.unwrap().len(), 2);
        assert!(rows(&load(&mut c).await.unwrap(), "tasks").is_empty());
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions[0]["fields"]["notes"] = json!("手动改了备注");
        let edited = prepare(&mut c, CONV, "", "整理书架", &actions, Some((id, 0)))
            .await
            .unwrap();
        assert_eq!(text(&edited, "message_id"), "first");
        assert_eq!(presentations(&mut c, CONV).await.unwrap().len(), 2);
        assert!(present(&mut c, CONV, id, 0, "stale").await.is_err());
        present(&mut c, CONV, id, 1, "newest").await.unwrap();
        let paused = transition_at(&mut c, CONV, id, 1, "paused", Some("pause-msg"))
            .await
            .unwrap();
        present(&mut c, CONV, id, 2, "paused-show").await.unwrap();
        assert_eq!(get(&mut c, id, CONV).await.unwrap(), paused);
        assert!(apply(&mut c, CONV, id, 2).await.is_err());
        assert!(present(&mut c, "other", id, 2, "cross-thread")
            .await
            .is_err());
        transition(&mut c, CONV, id, 2, "pending").await.unwrap();
        apply(&mut c, CONV, id, 3).await.unwrap();
        assert!(present(&mut c, CONV, id, 4, "closed").await.is_err());
        assert_eq!(rows(&load(&mut c).await.unwrap(), "tasks").len(), 1);
    });
}

#[test]
fn replacement_is_atomic_retires_old_confirmation_and_keeps_manual_fields() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op = prepare(&mut c, CONV, "first", "书架", &[book()], None)
            .await
            .unwrap();
        let old = text(&op, "id");
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions[0]["fields"]["title"] = json!("");
        assert!(
            replace_operation(&mut c, CONV, "bad", "无效替换", &actions, old, 0)
                .await
                .is_err()
        );
        assert_eq!(get(&mut c, old, CONV).await.unwrap(), op);
        actions[0]["fields"]["title"] = json!("[验收] 整理衣柜");
        let new = replace_operation(&mut c, CONV, "latest", "新方案", &actions, old, 0)
            .await
            .unwrap();
        let prior = get(&mut c, old, CONV).await.unwrap();
        assert_eq!(prior["state"], "cancelled");
        assert_eq!(prior["superseded_by"], new["id"]);
        assert!(apply(&mut c, CONV, old, 0).await.is_err());
        assert_eq!(new["preview"][0]["after"]["notes"], "手动备注必须保留");
        assert!(rows(&load(&mut c).await.unwrap(), "tasks").is_empty());
        let receipt = apply(&mut c, CONV, text(&new, "id"), 0).await.unwrap();
        assert_eq!(
            apply(&mut c, CONV, text(&new, "id"), 0).await.unwrap(),
            receipt
        );
        assert_eq!(rows(&load(&mut c).await.unwrap(), "tasks").len(), 1);
    });
}

#[test]
fn failed_replacement_storage_rolls_back_both_plans_and_placements() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op = prepare(&mut c, CONV, "first", "书架", &[book()], None)
            .await
            .unwrap();
        let initial = presentations(&mut c, CONV).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_presentation BEFORE INSERT ON assistant_operation_presentations WHEN NEW.reason='replace' BEGIN SELECT RAISE(ABORT,'fixture'); END;").execute(&mut c).await.unwrap();
        assert!(replace_operation(
            &mut c,
            CONV,
            "latest",
            "重做",
            op["actions"].as_array().unwrap(),
            text(&op, "id"),
            0
        )
        .await
        .is_err());
        assert_eq!(list(&mut c, CONV).await.unwrap(), vec![op]);
        assert_eq!(presentations(&mut c, CONV).await.unwrap(), initial);
    });
}

#[test]
fn display_migration_preserves_existing_operations_and_backfills_old_placement() {
    tauri::async_runtime::block_on(async {
        let mut c = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/007_assistant.sql"))
            .execute(&mut c)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/011_agent_runtime.sql"))
            .execute(&mut c)
            .await
            .unwrap();
        conversation(&mut c).await;
        sqlx::query("INSERT INTO assistant_operations(id,conversation_id,message_id,title,state,revision,actions,preview,created_at,updated_at) VALUES ('legacy',?,'old-msg','旧方案','paused',7,'[]','[]','old','old')").bind(CONV).execute(&mut c).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/012_operation_presentations.sql"
        ))
        .execute(&mut c)
        .await
        .unwrap();
        let migrated = get(&mut c, "legacy", CONV).await.unwrap();
        assert_eq!(migrated["state"], "paused");
        assert_eq!(migrated["revision"], 7);
        let views = presentations(&mut c, CONV).await.unwrap();
        assert_eq!(views[0]["message_id"], "old-msg");
        assert_eq!(views[0]["revision"], 7);
    });
}
