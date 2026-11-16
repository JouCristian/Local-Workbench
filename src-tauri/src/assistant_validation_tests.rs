use super::tests::{conversation, database, seed, CONV};
use super::*;

#[test]
fn two_linked_fuzzy_sessions_inherit_titles_without_writing_or_changing_deadlines() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let before = seed(&mut c).await;
        let task = &rows(&before, "tasks")[0];
        let actions = ["afternoon", "evening"].map(|p| json!({"key":p,"action":"create","table":"schedules","fields":{"task_id":task["id"],"date":"2026-11-17","period":p}}));
        let op = prepare(&mut c, CONV, "new", "两次复习", &actions, None)
            .await
            .unwrap();
        assert_eq!(load(&mut c).await.unwrap(), before);
        for item in op["preview"].as_array().unwrap() {
            assert_eq!(item["after"]["title"], task["title"]);
            assert_eq!(item["after"]["date"], "2026-11-17");
            for f in ["start_time", "end_time", "completed_at"] {
                assert!(item["after"][f].is_null());
            }
            assert_eq!(item["after"]["notes"], "");
            assert_eq!(item["inferred_fields"][0]["source"], "linked_task");
        }
        apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap();
        let after = load(&mut c).await.unwrap();
        assert_eq!(after["tasks"], before["tasks"]);
        assert_eq!(
            rows(&after, "schedules").len(),
            rows(&before, "schedules").len() + 2
        );
        assert!(prepare(&mut c, CONV, "dup", "重复", &actions, None)
            .await
            .unwrap_err()
            .contains("已有安排"));
    });
}

#[test]
fn same_batch_reference_inherits_title_and_optional_fields_stay_empty() {
    let source = json!({"projects":[],"stages":[],"tasks":[],"schedules":[],"events":[]});
    let (actions,items)=preview(&source,&[
        json!({"key":"s","action":"create","table":"schedules","fields":{"task_id":"study","date":"2026-11-17","period":"evening"}}),
        json!({"key":"t","ref":"study","action":"create","table":"tasks","fields":{"title":"学习编译原理"}})
    ]).unwrap();
    let task = items.iter().find(|i| i["table"] == "tasks").unwrap();
    let schedule = items.iter().find(|i| i["table"] == "schedules").unwrap();
    assert_eq!(schedule["after"]["task_id"], task["id"]);
    assert_eq!(schedule["after"]["title"], "学习编译原理");
    assert!(task["after"]["due_date"].is_null());
    assert!(task["after"]["project_id"].is_null());
    assert_eq!(
        actions.iter().find(|a| a["table"] == "schedules").unwrap()["fields"]["title"],
        "学习编译原理"
    );
}

#[test]
fn missing_title_error_points_to_original_batch_position_and_allows_semantic_repair() {
    let source = json!({"projects":[],"stages":[],"tasks":[],"schedules":[],"events":[]});
    let mut actions = vec![
        json!({"key":"session","action":"create","table":"schedules","fields":{"date":"2026-11-17","period":"afternoon"}}),
        json!({"key":"task","action":"create","table":"tasks","fields":{"title":"其它任务"}}),
    ];
    let error = preview(&source, &actions).unwrap_err();
    assert!(error.contains("第1项（schedules，步骤session）"), "{error}");
    assert!(error.contains("字段 title") && error.contains("拟定") && error.contains("未写入"));
    actions[0]["fields"]["title"] = json!("集中学习");
    let (_, items) = preview(&source, &actions).unwrap();
    assert_eq!(items.len(), 2);
    assert!(
        items.iter().find(|i| i["table"] == "schedules").unwrap()["after"]["task_id"].is_null()
    );
}

#[test]
fn required_dates_times_and_invalid_optional_values_are_not_guessed() {
    let source = json!({"projects":[],"stages":[],"tasks":[],"schedules":[],"events":[]});
    for (fields, expected) in [
        (json!({"title":"学习","period":"afternoon"}), "字段 date"),
        (
            json!({"title":"学习","date":"2026-02-30","period":"afternoon"}),
            "字段 date",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"exact"}),
            "字段 start_time",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"afternoon","start_time":"14:00"}),
            "字段 start_time/end_time",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"exact","start_time":"25:80"}),
            "字段 start_time",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"exact","start_time":"19:00","end_time":"18:00"}),
            "字段 end_time",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"afternoon","notes":null}),
            "字段 notes",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"afternoon","title_extra":"不允许"}),
            "字段 title_extra",
        ),
        (
            json!({"title":"学习","date":"2026-11-17","period":"afternoon","task_id":"unknown"}),
            "字段 task_id",
        ),
    ] {
        let error = preview(
            &source,
            &[json!({"key":"s","action":"create","table":"schedules","fields":fields})],
        )
        .unwrap_err();
        assert!(error.contains(expected), "expected {expected}: {error}");
    }
    let (_,items)=preview(&source,&[json!({"key":"s","action":"create","table":"schedules","fields":{"title":"晚间学习","date":"2026-11-17","period":"exact","start_time":"20:00"}})]).unwrap();
    assert!(items[0]["after"]["end_time"].is_null());
}

#[test]
fn explicit_title_and_updates_are_preserved_and_failed_revision_keeps_previous_form() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        let before = seed(&mut c).await;
        let task = &rows(&before, "tasks")[0];
        let op=prepare(&mut c,CONV,"new","安排",&[json!({"key":"s","action":"create","table":"schedules","fields":{"title":"用户自定标题","task_id":task["id"],"date":"2026-11-17","period":"evening","notes":"保留备注"}})],None).await.unwrap();
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions[0]["fields"]["date"] = Value::Null;
        assert!(prepare(
            &mut c,
            CONV,
            "bad",
            "安排",
            &actions,
            Some((text(&op, "id"), 0))
        )
        .await
        .is_err());
        assert_eq!(get(&mut c, text(&op, "id"), CONV).await.unwrap(), op);
        apply(&mut c, CONV, text(&op, "id"), 0).await.unwrap();
        let data = load(&mut c).await.unwrap();
        let s = rows(&data, "schedules")
            .iter()
            .find(|s| s["title"] == "用户自定标题")
            .unwrap();
        let (_,edited)=preview(&data,&[json!({"key":"edit","action":"update","table":"schedules","id":s["id"],"fields":{"date":"2026-11-18"}})]).unwrap();
        assert_eq!(edited[0]["after"]["notes"], "保留备注");
        assert_eq!(edited[0]["after"]["title"], "用户自定标题");
        assert!(preview(&data,&[json!({"key":"edit","action":"update","table":"schedules","id":s["id"],"fields":{"title":""}})]).unwrap_err().contains("字段 title"));
    });
}

#[test]
fn inferred_title_is_frozen_in_confirmed_plan_and_not_recalculated() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op=prepare(&mut c,CONV,"m","学习",&[
            json!({"key":"t","ref":"t","action":"create","table":"tasks","fields":{"title":"阅读"}}),
            json!({"key":"s","action":"create","table":"schedules","fields":{"task_id":"t","date":"2026-11-17","period":"morning"}})
        ],None).await.unwrap();
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions.iter_mut().find(|a| a["key"] == "t").unwrap()["fields"]["title"] =
            json!("阅读新标题");
        let op = prepare(
            &mut c,
            CONV,
            "",
            "学习",
            &actions,
            Some((text(&op, "id"), 0)),
        )
        .await
        .unwrap();
        let s = op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["key"] == "s")
            .unwrap();
        assert_eq!(s["after"]["title"], "阅读");
        apply(&mut c, CONV, text(&op, "id"), 1).await.unwrap();
        assert_eq!(
            rows(&load(&mut c).await.unwrap(), "schedules")[0]["title"],
            "阅读"
        );
    });
}
