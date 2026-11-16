use super::tests::{call, mock_server, prose, request, start};
use super::*;
use crate::assistant_operations::tests::{conversation, database, CONV};

#[test]
#[ignore = "Uses the saved DeepSeek credential natively; all data is generic and in-memory"]
fn actual_deepseek_semantic_schedule_smoke() {
    tauri::async_runtime::block_on(async {
        let key = super::super::secret().expect("Configure DeepSeek first; never log the key");
        let http = super::super::client().unwrap();
        let mut c = database().await;
        conversation(&mut c).await;
        let initial = ops::prepare(&mut c,CONV,"seed","通用测试数据",&[
            json!({"key":"exam","ref":"exam","table":"tasks","action":"create","fields":{"title":"编译原理期末复习","due_date":"2026-11-27","priority":"high"}}),
            json!({"key":"class","table":"schedules","action":"create","fields":{"title":"示例课程","date":"2026-11-17","period":"exact","start_time":"08:00","end_time":"09:40"}})
        ],None).await.unwrap();
        ops::apply(&mut c, CONV, ops::text(&initial, "id"), 0)
            .await
            .unwrap();
        sqlx::query("DELETE FROM assistant_operations")
            .execute(&mut c)
            .await
            .unwrap();
        let baseline = ops::load(&mut c).await.unwrap();
        let task = &ops::rows(&baseline, "tasks")[0];
        let mut messages = vec![];
        let mut report = vec![];
        async fn turn(
            c: &mut SqliteConnection,
            http: &reqwest::Client,
            key: &str,
            messages: &mut Vec<Value>,
            report: &mut Vec<Value>,
            label: &str,
            input: &str,
            event: Option<&str>,
        ) {
            if !input.is_empty() {
                messages.push(json!({"role":"user","content":input}));
            }
            let mut req = request(messages.clone(), true);
            if let Some(id) = event {
                req.context["operation_event"] = json!(id);
            }
            start(c, &req).await;
            let time = std::time::Instant::now();
            let response = run(http, key, &req, &Channel::new(|_| Ok(())), c).await;
            let reply = response
                .as_ref()
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null);
            let steps: Vec<String> = sqlx::query_scalar(
                "SELECT result FROM assistant_steps WHERE run_id=? ORDER BY sequence",
            )
            .bind(&req.id)
            .fetch_all(&mut *c)
            .await
            .unwrap();
            let results: Vec<Value> = steps
                .iter()
                .map(|s| serde_json::from_str(s).unwrap())
                .collect();
            report.push(json!({"label":label,"answer":reply["answer"],"results":results,"error":response.as_ref().err(),"duration_ms":time.elapsed().as_millis()}));
            std::fs::create_dir_all("../artifacts/semantic-schedule-provider").unwrap();
            std::fs::write(
                "../artifacts/semantic-schedule-provider/result.json",
                serde_json::to_string_pretty(report).unwrap(),
            )
            .unwrap();
            println!(
                "{label}: {} tools, {}ms",
                results.len(),
                time.elapsed().as_millis()
            );
            response.unwrap();
            messages.push(json!({"role":"assistant","content":reply["answer"]}));
        }
        turn(&mut c,&http,&key,&mut messages,&mut report,"two fuzzy sessions linked to existing task","我最近在准备编译原理的期末考试，我要安排两次集中学习的时间，就安排在明天下午和明天晚上吧",None).await;
        let plans = ops::list(&mut c, CONV).await.unwrap();
        assert_eq!(plans.len(), 1, "{:?}", report.last());
        let mut op = plans[0].clone();
        let id = ops::text(&op, "id").to_string();
        assert_eq!(op["preview"].as_array().unwrap().len(), 2);
        for period in ["afternoon", "evening"] {
            let item = op["preview"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["after"]["period"] == period)
                .unwrap();
            assert_eq!(item["table"], "schedules");
            assert_eq!(item["after"]["task_id"], task["id"]);
            assert_eq!(item["after"]["date"], "2026-11-17");
            assert!(!ops::text(&item["after"], "title").is_empty());
            assert!(item["after"]["start_time"].is_null() && item["after"]["end_time"].is_null());
        }
        assert_eq!(ops::load(&mut c).await.unwrap(), baseline);
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "revise one date and one note",
            "下午那次备注写复习词法分析；晚上那次改到后天晚上，其它内容不动。",
            None,
        )
        .await;
        op = ops::get(&mut c, &id, CONV).await.unwrap();
        assert_eq!(ops::list(&mut c, CONV).await.unwrap().len(), 1);
        let afternoon = op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["after"]["period"] == "afternoon")
            .unwrap();
        let evening = op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["after"]["period"] == "evening")
            .unwrap();
        assert_eq!(afternoon["after"]["date"], "2026-11-17");
        assert!(ops::text(&afternoon["after"], "notes").contains("词法分析"));
        assert_eq!(evening["after"]["date"], "2026-11-18");
        let preserved = op.clone();
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "optional end-time explanation does not mutate",
            "没有结束时间也可以吗？先不改任何内容。",
            None,
        )
        .await;
        assert_eq!(ops::get(&mut c, &id, CONV).await.unwrap(), preserved);
        ops::apply(&mut c, CONV, &id, op["revision"].as_i64().unwrap())
            .await
            .unwrap();
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "actual confirmation receipt",
            "",
            Some(&id),
        )
        .await;
        let saved = ops::load(&mut c).await.unwrap();
        assert_eq!(saved["tasks"], baseline["tasks"]);
        assert_eq!(ops::rows(&saved, "schedules").len(), 3);
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "independent fuzzy schedule leaves optional fields empty",
            "再创建一条独立日程：明天上午散步，不关联任务，备注和结束时间暂时不填。",
            None,
        )
        .await;
        let independent = ops::list(&mut c, CONV)
            .await
            .unwrap()
            .into_iter()
            .find(|o| o["state"] == "pending")
            .expect("Expected independent schedule preview");
        assert_eq!(independent["preview"].as_array().unwrap().len(), 1);
        let walk = &independent["preview"][0];
        assert_eq!(walk["table"], "schedules");
        assert_eq!(walk["after"]["date"], "2026-11-17");
        assert_eq!(walk["after"]["period"], "morning");
        assert_eq!(walk["after"]["notes"], "");
        assert!(walk["after"]["task_id"].is_null() && walk["after"]["end_time"].is_null());
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "cancel independent preview without deleting saved sessions",
            "这条散步日程先不要了，取消它，已经保存的复习安排保持不变。",
            None,
        )
        .await;
        assert_eq!(
            ops::get(&mut c, ops::text(&independent, "id"), CONV)
                .await
                .unwrap()["state"],
            "cancelled"
        );
        assert_eq!(ops::load(&mut c).await.unwrap(), saved);
        let count = ops::list(&mut c, CONV).await.unwrap().len();
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "advice-only creates no operation",
            "先不要创建任何事项，只给我三个集中学习的小建议。",
            None,
        )
        .await;
        assert_eq!(ops::list(&mut c, CONV).await.unwrap().len(), count);
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "missing required date is clarified not guessed",
            "帮我安排一次独立的集中阅读，具体哪天还没定，日期不要替我猜。",
            None,
        )
        .await;
        assert_eq!(ops::list(&mut c, CONV).await.unwrap().len(), count);
        turn(
            &mut c,
            &http,
            &key,
            &mut messages,
            &mut report,
            "followup supplies date and exact start without an end",
            "那就后天20:00开始阅读吧，结束时间暂时不定，不关联任何任务。",
            None,
        )
        .await;
        let exact = ops::list(&mut c, CONV)
            .await
            .unwrap()
            .into_iter()
            .find(|o| o["state"] == "pending")
            .expect("Expected exact schedule preview after clarification");
        let reading = &exact["preview"][0];
        assert_eq!(reading["table"], "schedules");
        assert_eq!(reading["after"]["date"], "2026-11-18");
        assert_eq!(reading["after"]["period"], "exact");
        assert_eq!(reading["after"]["start_time"], "20:00");
        assert!(reading["after"]["end_time"].is_null() && reading["after"]["task_id"].is_null());
        assert_eq!(ops::load(&mut c).await.unwrap(), saved);
    });
}

#[test]
fn field_schema_describes_empty_optionals_and_semantic_titles() {
    let defs = tools::definitions();
    let fields = &defs
        .iter()
        .find(|d| d["function"]["name"] == "prepare_operation")
        .unwrap()["function"]["parameters"]["properties"]["actions"]["items"]["properties"]
        ["fields"];
    assert_eq!(fields["additionalProperties"], false);
    assert_eq!(fields["properties"]["title"]["minLength"], 1);
    assert_eq!(fields["properties"]["title"]["maxLength"], 300);
    assert_eq!(
        fields["properties"]["due_date"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(fields["properties"]["notes"]["type"], "string");
}

#[test]
fn field_error_reaches_model_and_targeted_repair_preserves_other_fields_without_writing() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let before = ops::load(&mut c).await.unwrap();
        let bad = json!({"title":"晚间学习","actions":[{"key":"study","table":"schedules","action":"create","fields":{"date":"2026-11-17","period":"evening","notes":"复习第一章"}}]});
        let mut fixed = bad.clone();
        fixed["actions"][0]["fields"]["title"] = json!("复习第一章");
        let (url, server) = mock_server(vec![
            call("bad", "prepare_operation", bad),
            call("fixed", "prepare_operation", fixed),
            prose("已根据描述拟定标题，晚间复习预览已准备，请核对后保存。"),
        ]);
        let req = request(
            vec![json!({"role":"user","content":"明天晚上学习，复习第一章，帮我安排一下。"})],
            true,
        );
        start(&mut c, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut c,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(
            requests[0]["tool_choice"], "required",
            "New operations need a real tool decision even without pending forms"
        );
        let failure: Value = serde_json::from_str(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["recovery"]["retry_allowed"], true);
        assert!(ops::text(&failure, "error").contains("字段 title"));
        assert!(ops::text(&failure, "error").contains("第1项"));
        assert_eq!(ops::load(&mut c).await.unwrap(), before);
        let ops = ops::list(&mut c, CONV).await.unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["preview"][0]["after"]["notes"], "复习第一章");
        assert_eq!(ops[0]["preview"][0]["after"]["period"], "evening");
        assert!(ops[0]["preview"][0]["after"]["start_time"].is_null());
        ops::apply(&mut c, CONV, ops::text(&ops[0], "id"), 0)
            .await
            .unwrap();
        assert_eq!(
            ops::rows(&ops::load(&mut c).await.unwrap(), "schedules").len(),
            1
        );
    });
}

#[test]
fn plain_chat_without_pending_forms_can_explicitly_choose_no_operation() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let (url, server) = mock_server(vec![
            call("chat", "keep_operations", json!({})),
            prose("可以先休息，再按精力安排学习。"),
        ]);
        let req = request(
            vec![json!({"role":"user","content":"只给学习建议，不创建任何事项。"})],
            false,
        );
        start(&mut c, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut c,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests[0]["tool_choice"], "required");
        assert_eq!(requests[1]["tool_choice"], "auto");
        let facts = ops::text(
            requests[1]["messages"].as_array().unwrap().last().unwrap(),
            "content",
        );
        assert!(facts.contains("no_new_operation") && facts.contains("\"presented\":false"));
        assert!(ops::list(&mut c, CONV).await.unwrap().is_empty());
        assert!(ops::rows(&ops::load(&mut c).await.unwrap(), "tasks").is_empty());
    });
}

#[test]
fn latest_snapshot_follows_stale_history_and_patch_schema_preserves_untouched_fields() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let op=ops::prepare(&mut c,CONV,"original","整理",&[json!({"key":"t","table":"tasks","action":"create","fields":{"title":"书架","notes":"最新手动备注必须保留"}})],None).await.unwrap();
        let (url, server) = mock_server(vec![
            call(
                "rename",
                "revise_operation",
                json!({"id":op["id"],"revision":0,"patches":[{"key":"t","fields":{"title":"衣柜"}}]}),
            ),
            prose("标题预览已改，手动备注保持原样。"),
        ]);
        let req = request(
            vec![
                json!({"role":"assistant","content":"原备注：先整理最上层。"}),
                json!({"role":"user","content":"标题改为衣柜，手动备注保留。"}),
            ],
            true,
        );
        start(&mut c, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut c,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        let latest = requests[0]["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(latest["role"], "system");
        assert!(ops::text(latest, "content").contains("最新手动备注必须保留"));
        let def = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["function"]["name"] == "revise_operation")
            .unwrap();
        assert!(ops::text(
            &def["function"]["parameters"]["properties"]["patches"]["items"]["properties"]
                ["fields"],
            "description"
        )
        .contains("必须省略"));
        assert_eq!(
            ops::get(&mut c, ops::text(&op, "id"), CONV).await.unwrap()["preview"][0]["after"]
                ["notes"],
            "最新手动备注必须保留"
        );
    });
}

#[test]
fn identical_invalid_retry_stops_and_requests_explanation_instead_of_looping() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let bad = json!({"title":"学习","actions":[{"key":"s","table":"schedules","action":"create","fields":{"title":"学习","period":"afternoon"}}]});
        let (url, server) = mock_server(vec![
            call("a", "prepare_operation", bad.clone()),
            call("b", "prepare_operation", bad),
            prose("还没有生成预览。你希望安排在哪一天？"),
        ]);
        let req = request(
            vec![json!({"role":"user","content":"安排下午学习，日期暂时没定"})],
            true,
        );
        start(&mut c, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut c,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests[2]["tool_choice"], "none");
        let failure: Value = serde_json::from_str(
            requests[2]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(failure["recovery"]["retry_allowed"], false);
        assert!(ops::list(&mut c, CONV).await.unwrap().is_empty());
        assert!(ops::rows(&ops::load(&mut c).await.unwrap(), "schedules").is_empty());
    });
}

#[test]
fn three_targeted_but_unresolved_errors_exhaust_repair_budget() {
    tauri::async_runtime::block_on(async {
        let mut c = database().await;
        conversation(&mut c).await;
        let outputs=(1..=3).map(|i|call(&format!("a{i}"),"prepare_operation",json!({"title":"学习","actions":[{"key":"s","table":"schedules","action":"create","fields":{"title":format!("学习{i}"),"period":"afternoon"}}]}))).chain([prose("需要先明确执行日期，尚未生成预览。")]).collect();
        let (url, server) = mock_server(outputs);
        let req = request(
            vec![json!({"role":"user","content":"安排下午学习，日期没定"})],
            true,
        );
        start(&mut c, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut c,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests[3]["tool_choice"], "none");
        let failure: Value = serde_json::from_str(
            requests[3]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(failure["recovery"]["same_error_count"], 3);
        assert_eq!(failure["recovery"]["retry_allowed"], false);
        assert!(ops::list(&mut c, CONV).await.unwrap().is_empty());
    });
}
