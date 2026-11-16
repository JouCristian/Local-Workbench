use super::*;
use ops::text;
#[test]
fn tools_have_no_apply_or_arbitrary_execution_capability() {
    let names: Vec<_> = tools::definitions()
        .into_iter()
        .map(|v| v["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"prepare_operation".into()));
    assert!(!names
        .iter()
        .any(|s| s.contains("apply") || s.contains("sql") || s.contains("shell")));
}

#[test]
fn pending_form_requires_a_tool_decision_and_plain_chat_keeps_location() {
    tauri::async_runtime::block_on(async {
        let mut conn = crate::assistant_operations::tests::database().await;
        crate::assistant_operations::tests::conversation(&mut conn).await;
        let conv = crate::assistant_operations::tests::CONV;
        let op = ops::prepare(
            &mut conn,
            conv,
            "original",
            "书架",
            &[json!({"key":"book","table":"tasks","action":"create","fields":{"title":"书架"}})],
            None,
        )
        .await
        .unwrap();
        let before = ops::presentations(&mut conn, conv).await.unwrap();
        let (url, server) = mock_server(vec![
            call("hold", "keep_operations", json!({})),
            prose("编译器将源代码转换为目标程序，原方案保持不变。"),
        ]);
        let req = request(
            vec![json!({"role":"user","content":"先不动方案，解释编译器。"})],
            false,
        );
        start(&mut conn, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut conn,
        )
        .await
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests[0]["tool_choice"], "required");
        assert_eq!(requests[1]["tool_choice"], "auto");
        let guard = text(
            requests[1]["messages"].as_array().unwrap().last().unwrap(),
            "content",
        );
        assert!(guard.contains("kept_unchanged"));
        assert_eq!(
            ops::get(&mut conn, text(&op, "id"), conv).await.unwrap(),
            op
        );
        assert_eq!(ops::presentations(&mut conn, conv).await.unwrap(), before);
    });
}

#[test]
#[ignore = "Uses the locally saved DeepSeek key with an empty isolated in-memory database"]
fn actual_deepseek_form_presentation_smoke() {
    tauri::async_runtime::block_on(async {
        let key =
            super::super::secret().expect("Configure DeepSeek first; the key is never logged");
        let http = super::super::client().unwrap();
        let mut conn = crate::assistant_operations::tests::database().await;
        crate::assistant_operations::tests::conversation(&mut conn).await;
        let conv = crate::assistant_operations::tests::CONV;
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
        ) -> String {
            if !input.is_empty() {
                messages.push(json!({"role":"user","content":input}));
            }
            let mut req = request(messages.clone(), true);
            if let Some(id) = event {
                req.context["operation_event"] = json!(id);
            }
            start(c, &req).await;
            let time = std::time::Instant::now();
            let reply: Value = serde_json::from_str(
                &run(http, key, &req, &Channel::new(|_| Ok(())), c)
                    .await
                    .unwrap(),
            )
            .unwrap();
            let calls: Vec<String> = sqlx::query_scalar(
                "SELECT tool FROM assistant_steps WHERE run_id=? ORDER BY sequence",
            )
            .bind(&req.id)
            .fetch_all(&mut *c)
            .await
            .unwrap();
            println!("{label}: {:?}, {}ms", calls, time.elapsed().as_millis());
            report.push(json!({"label":label,"tools":calls,"answer":reply["answer"],"message_id":req.context["message_id"],"duration_ms":time.elapsed().as_millis()}));
            std::fs::create_dir_all("../artifacts/presentation-provider").unwrap();
            std::fs::write(
                "../artifacts/presentation-provider/result.json",
                serde_json::to_string_pretty(report).unwrap(),
            )
            .unwrap();
            messages.push(json!({"role":"assistant","content":reply["answer"]}));
            if matches!(
                label,
                "create independent book task"
                    | "revise reattaches below current reply"
                    | "can't see form means present, not duplicate"
                    | "independent second task"
            ) {
                let answer = text(&reply, "answer");
                assert!(
                    !answer.contains("已确认保存")
                        && !answer.contains("已创建为")
                        && !answer.contains("已经创建"),
                    "A pending preview must not claim actual creation: {answer}"
                );
            }
            text(&req.context, "message_id").to_string()
        }
        let first = turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "create independent book task",
            "帮我创建一个任务：[验收] 整理书架，截止时间暂时不定。",
            None,
        )
        .await;
        let mut pending = ops::list(&mut conn, conv).await.unwrap();
        assert_eq!(pending.len(), 1);
        let mut op = pending.pop().unwrap();
        let id = text(&op, "id").to_string();
        assert_eq!(op["preview"][0]["after"]["project_id"], Value::Null);
        assert_eq!(op["preview"][0]["after"]["due_date"], Value::Null);
        let trace: Vec<String> =
            sqlx::query_scalar("SELECT result FROM assistant_steps WHERE tool='query_records'")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        for result in trace {
            let v: Value = serde_json::from_str(&result).unwrap();
            assert_ne!(v["data"]["table"], "projects");
            assert_ne!(v["data"]["table"], "stages");
        }
        let edited = turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "revise reattaches below current reply",
            "优先级改成低，备注写先整理最上层，其它保持不变。",
            None,
        )
        .await;
        op = ops::get(&mut conn, &id, conv).await.unwrap();
        assert_eq!(op["preview"][0]["after"]["priority"], "low");
        let views = ops::presentations(&mut conn, conv).await.unwrap();
        assert_eq!(views[0]["message_id"], first);
        assert_eq!(views.last().unwrap()["message_id"], edited);
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions[0]["fields"]["notes"] = json!("手动补充：先整理最上层，保留这个备注");
        op = ops::prepare(
            &mut conn,
            conv,
            "",
            text(&op, "title"),
            &actions,
            Some((&id, op["revision"].as_i64().unwrap())),
        )
        .await
        .unwrap();
        let shown = turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "can't see form means present, not duplicate",
            "核对界面在哪里？我看不到了呢？你再给我生成一个。",
            None,
        )
        .await;
        assert!(report.last().unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "present_operation"));
        assert_eq!(ops::get(&mut conn, &id, conv).await.unwrap(), op);
        assert_eq!(
            ops::presentations(&mut conn, conv)
                .await
                .unwrap()
                .last()
                .unwrap()["message_id"],
            shown
        );
        assert_eq!(ops::list(&mut conn, conv).await.unwrap().len(), 1);
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "pause",
            "这组操作先暂停。",
            None,
        )
        .await;
        op = ops::get(&mut conn, &id, conv).await.unwrap();
        assert_eq!(op["state"], "paused");
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "redisplay preserves paused state",
            "再把表单放在这里，保持暂停，先别恢复也别保存。",
            None,
        )
        .await;
        assert_eq!(ops::get(&mut conn, &id, conv).await.unwrap(), op);
        turn(&mut conn,&http,&key,&mut messages,&mut report,"explicit replacement","原来的书架方案不要了，作废它，重新做一份整理衣柜的方案；优先级和手动备注保留，截止仍不定。给我新的待确认表单。",None).await;
        let old = ops::get(&mut conn, &id, conv).await.unwrap();
        assert_eq!(old["state"], "cancelled");
        let new_id = text(&old, "superseded_by").to_string();
        assert!(!new_id.is_empty());
        let replacement = ops::get(&mut conn, &new_id, conv).await.unwrap();
        assert_eq!(replacement["state"], "pending");
        assert!(text(&replacement["preview"][0]["after"], "title").contains("衣柜"));
        assert_eq!(
            replacement["preview"][0]["after"]["notes"],
            op["preview"][0]["after"]["notes"]
        );
        assert!(
            ops::apply(&mut conn, conv, &id, old["revision"].as_i64().unwrap())
                .await
                .is_err()
        );
        assert!(ops::rows(&ops::load(&mut conn).await.unwrap(), "tasks").is_empty());
        ops::apply(
            &mut conn,
            conv,
            &new_id,
            replacement["revision"].as_i64().unwrap(),
        )
        .await
        .unwrap();
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "confirm only one task",
            "",
            Some(&new_id),
        )
        .await;
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "independent second task",
            "另外新建一个独立任务：[验收] 清理桌面，不设截止，不要修改刚才的衣柜任务。",
            None,
        )
        .await;
        let extra = ops::list(&mut conn, conv)
            .await
            .unwrap()
            .into_iter()
            .find(|o| o["state"] == "pending")
            .unwrap();
        assert!(text(&extra["preview"][0]["after"], "title").contains("桌面"));
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "cancel extra only",
            "不要清理桌面这组了，取消它。",
            None,
        )
        .await;
        assert_eq!(
            ops::get(&mut conn, text(&extra, "id"), conv).await.unwrap()["state"],
            "cancelled"
        );
        assert_eq!(
            ops::rows(&ops::load(&mut conn).await.unwrap(), "tasks").len(),
            1
        );
    });
}

pub(super) fn request(messages: Vec<Value>, read_local: bool) -> ChatRequest {
    ChatRequest {
        id: uuid::Uuid::new_v4().to_string(),
        model: "deepseek-flash".into(),
        messages,
        context: json!({"conversation_id":crate::assistant_operations::tests::CONV,"message_id":uuid::Uuid::new_v4().to_string(),"today":"2026-11-16","now_time":"00:45","timezone":"Asia/Shanghai","read_local":read_local}),
        drafts: vec![],
        action_event: None,
    }
}
pub(super) async fn start(conn: &mut SqliteConnection, req: &ChatRequest) {
    sqlx::query("INSERT INTO assistant_runs(id,conversation_id,message_id,state,started_at) VALUES (?,?,?,'running',?)").bind(&req.id).bind(ops::text(&req.context,"conversation_id")).bind(ops::text(&req.context,"message_id")).bind(ops::stamp()).execute(conn).await.unwrap();
}
pub(super) fn mock_server(outputs: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut requests = vec![];
        for output in outputs {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = vec![];
            let (end, length) = loop {
                let mut b = [0; 8192];
                let n = s.read(&mut b).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&b[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = header
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < end + length {
                let mut b = [0; 8192];
                let n = s.read(&mut b).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&b[..n]);
            }
            let input: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
            assert!(input.get("response_format").is_none());
            assert!(input["tools"].as_array().is_some());
            requests.push(input);
            let body = json!({"choices":[output]}).to_string();
            write!(s,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
        requests
    });
    (url, handle)
}
pub(super) fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"message":{"role":"assistant","content":null,"tool_calls":[{"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":"tool_calls"})
}
pub(super) fn prose(text: &str) -> Value {
    json!({"message":{"role":"assistant","content":text},"finish_reason":"stop"})
}

#[test]
fn native_loop_queries_prepares_batch_and_returns_real_results_without_writing() {
    tauri::async_runtime::block_on(async {
        let mut conn = crate::assistant_operations::tests::database().await;
        let before = crate::assistant_operations::tests::seed(&mut conn).await;
        let actions=ops::rows(&before,"tasks").iter().enumerate().map(|(i,t)|json!({"key":i.to_string(),"table":"tasks","action":"update","id":t["id"],"shift_due_days":2})).collect::<Vec<_>>();
        let (url, server) = mock_server(vec![
            call(
                "q",
                "query_records",
                json!({"table":"tasks","overdue":true}),
            ),
            call(
                "p",
                "prepare_operation",
                json!({"title":"顺延两项任务","actions":actions}),
            ),
            prose("两项截止调整预览已准备，日程保持原样，请核对后确认。"),
        ]);
        let req = request(
            vec![json!({"role":"user","content":"两项逾期任务都往后推两天，日程不动"})],
            true,
        );
        start(&mut conn, &req).await;
        let result = run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut conn,
        )
        .await
        .unwrap();
        assert!(result.contains("预览已准备"));
        let requests = server.join().unwrap();
        let tool_result: Value = serde_json::from_str(
            requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(tool_result["data"]["total"], 2);
        let latest = requests[2]["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(latest["role"], "system");
        assert!(text(latest, "content").contains("requires_user_confirmation"));
        assert!(text(latest, "content").contains("business_changes"));
        assert_eq!(ops::load(&mut conn).await.unwrap(), before);
        let op = ops::list(&mut conn, crate::assistant_operations::tests::CONV)
            .await
            .unwrap()
            .into_iter()
            .find(|o| o["state"] == "pending")
            .unwrap();
        assert_eq!(op["preview"].as_array().unwrap().len(), 2);
        let receipt = ops::apply(
            &mut conn,
            crate::assistant_operations::tests::CONV,
            ops::text(&op, "id"),
            0,
        )
        .await
        .unwrap();
        assert_eq!(receipt["count"], 2);
    });
}

#[test]
fn tools_can_fail_recover_and_respect_privacy() {
    tauri::async_runtime::block_on(async {
        let mut conn = crate::assistant_operations::tests::database().await;
        crate::assistant_operations::tests::seed(&mut conn).await;
        // Existing business data, but no previously shared operation in this chat.
        sqlx::query("DELETE FROM assistant_operations")
            .execute(&mut conn)
            .await
            .unwrap();
        let (url, server) = mock_server(vec![
            call("no", "execute_sql", json!({"sql":"DELETE FROM tasks"})),
            call("q", "query_records", json!({"table":"tasks"})),
            prose("当前未开启读取工作台，不能查看任务；可以继续普通聊天。"),
        ]);
        let req = request(vec![json!({"role":"user","content":"查任务"})], false);
        start(&mut conn, &req).await;
        run_at(
            &reqwest::Client::new(),
            &url,
            "fixture-key",
            &req,
            &Channel::new(|_| Ok(())),
            &mut conn,
        )
        .await
        .unwrap();
        for req in server.join().unwrap() {
            assert!(!req.to_string().contains("任务甲"));
            assert!(!req.to_string().contains("任务乙"));
        }
        assert_eq!(
            ops::rows(&ops::load(&mut conn).await.unwrap(), "tasks").len(),
            2
        );
    });
}

#[test]
#[ignore = "Uses the locally saved DeepSeek key, generic isolated in-memory database only"]
fn actual_deepseek_multiturn_runtime_smoke() {
    tauri::async_runtime::block_on(async {
        let key = super::super::secret()
            .expect("A DeepSeek key must already be configured; its value is never logged");
        let http = super::super::client().unwrap();
        let mut conn = crate::assistant_operations::tests::database().await;
        let seeded = crate::assistant_operations::tests::seed(&mut conn).await;
        // The fixture reproduces the reported case: both old executions completed, tasks overdue.
        let independent = ops::rows(&seeded, "tasks")
            .iter()
            .find(|r| r["project_id"].is_null())
            .unwrap();
        let s=ops::prepare(&mut conn,crate::assistant_operations::tests::CONV,"seed","第二个历史安排",&[json!({"key":"s2","table":"schedules","action":"create","fields":{"title":"执行乙","task_id":independent["id"],"date":"2026-11-13","period":"afternoon","completed_at":"2026-11-15T08:48:00Z"}})],None).await.unwrap();
        ops::apply(
            &mut conn,
            crate::assistant_operations::tests::CONV,
            ops::text(&s, "id"),
            0,
        )
        .await
        .unwrap();
        let original = ops::load(&mut conn).await.unwrap();
        let mut messages = vec![];
        let mut report = vec![];
        async fn turn(
            conn: &mut SqliteConnection,
            http: &reqwest::Client,
            key: &str,
            messages: &mut Vec<Value>,
            report: &mut Vec<Value>,
            label: &str,
            input: &str,
            event: Option<&str>,
        ) -> Value {
            if !input.is_empty() {
                messages.push(json!({"role":"user","content":input}));
            }
            let mut req = request(messages.clone(), true);
            if let Some(id) = event {
                req.context["operation_event"] = json!(id);
            }
            start(conn, &req).await;
            let time = std::time::Instant::now();
            let result: Value = serde_json::from_str(
                &run(http, key, &req, &Channel::new(|_| Ok(())), conn)
                    .await
                    .unwrap(),
            )
            .unwrap();
            let calls: Vec<String> = sqlx::query_scalar(
                "SELECT tool FROM assistant_steps WHERE run_id=? ORDER BY sequence",
            )
            .bind(&req.id)
            .fetch_all(&mut *conn)
            .await
            .unwrap();
            println!(
                "{label}: {} tools, {}ms",
                calls.len(),
                time.elapsed().as_millis()
            );
            report.push(json!({"label":label,"tools":calls,"answer":result["answer"],"duration_ms":time.elapsed().as_millis()}));
            std::fs::create_dir_all("../artifacts/runtime-provider").unwrap();
            std::fs::write(
                "../artifacts/runtime-provider/result.json",
                serde_json::to_string_pretty(&report).unwrap(),
            )
            .unwrap();
            messages.push(json!({"role":"assistant","content":result["answer"]}));
            result
        }
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "overdue + completed history",
            "我是不是有两项逾期任务？它们现在还有没有待执行的日程？",
            None,
        )
        .await;
        assert!(report.last().unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "query_records"));
        turn(&mut conn,&http,&key,&mut messages,&mut report,"pause and scope","先别改，只有刚才那两项逾期任务需要把原截止顺延两天，日程不要动。先记住这个要求，告诉我会变成哪天。",None).await;
        assert!(
            !ops::list(&mut conn, crate::assistant_operations::tests::CONV)
                .await
                .unwrap()
                .iter()
                .any(|o| o["state"] == "pending")
        );
        // Simulate an external UI edit, then test the short referential refresh.
        sqlx::query("UPDATE schedules SET completed_at=NULL,updated_at=? WHERE id=?")
            .bind(ops::stamp())
            .bind(ops::text(&original["schedules"][0], "id"))
            .execute(&mut conn)
            .await
            .unwrap();
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "short followup must requery",
            "我刚在日程页把其中一次改回未执行了，你现在再看看呢？先只核对状态。",
            None,
        )
        .await;
        assert!(report.last().unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "query_records"));
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "prepare actual update",
            "现在继续，就按刚才的范围和顺延两天要求，生成这两项已有任务的批量修改预览，日程不动。",
            None,
        )
        .await;
        let mut pending = ops::list(&mut conn, crate::assistant_operations::tests::CONV)
            .await
            .unwrap()
            .into_iter()
            .filter(|o| o["state"] == "pending")
            .collect::<Vec<_>>();
        assert_eq!(
            pending.len(),
            1,
            "Expected one batch update, not a refusal or duplicate creation"
        );
        let mut op = pending.pop().unwrap();
        assert_eq!(op["preview"].as_array().unwrap().len(), 2);
        assert!(op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["action"] == "update"
                && i["after"]["due_date"] == "2026-11-17"
                && i["after"]["due_time"] == "23:59"));
        // Manual note edit must survive the next model revision.
        let mut actions = op["actions"].as_array().unwrap().clone();
        actions[0]["fields"]["notes"] = json!("手动备注必须保留");
        op = ops::prepare(
            &mut conn,
            crate::assistant_operations::tests::CONV,
            "",
            ops::text(&op, "title"),
            &actions,
            Some((ops::text(&op, "id"), op["revision"].as_i64().unwrap())),
        )
        .await
        .unwrap();
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "in-place revision preserves manual fields",
            "把当前预览中任务乙的优先级改成高，其它字段包括手动备注、两项截止都保持不变。",
            None,
        )
        .await;
        op = ops::get(
            &mut conn,
            ops::text(&op, "id"),
            crate::assistant_operations::tests::CONV,
        )
        .await
        .unwrap();
        assert!(op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["after"]["notes"] == "手动备注必须保留"));
        assert!(op["preview"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["after"]["title"] == "任务乙" && i["after"]["priority"] == "high"));
        assert_eq!(
            ops::rows(&ops::load(&mut conn).await.unwrap(), "tasks"),
            ops::rows(&original, "tasks")
        );
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "pause lifecycle",
            "这组操作先暂停，我等会再确认。",
            None,
        )
        .await;
        op = ops::get(
            &mut conn,
            ops::text(&op, "id"),
            crate::assistant_operations::tests::CONV,
        )
        .await
        .unwrap();
        assert_eq!(op["state"], "paused");
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "chat while paused",
            "先聊点别的，用三句话解释编译器是什么，不要动这组操作。",
            None,
        )
        .await;
        assert_eq!(
            ops::get(
                &mut conn,
                ops::text(&op, "id"),
                crate::assistant_operations::tests::CONV
            )
            .await
            .unwrap()["state"],
            "paused"
        );
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "resume without executing",
            "回到刚才那组批量修改，继续准备，先不要自动保存。",
            None,
        )
        .await;
        op = ops::get(
            &mut conn,
            ops::text(&op, "id"),
            crate::assistant_operations::tests::CONV,
        )
        .await
        .unwrap();
        assert_eq!(op["state"], "pending");
        ops::apply(
            &mut conn,
            crate::assistant_operations::tests::CONV,
            ops::text(&op, "id"),
            op["revision"].as_i64().unwrap(),
        )
        .await
        .unwrap();
        let after = ops::load(&mut conn).await.unwrap();
        assert_eq!(ops::rows(&after, "tasks").len(), 2);
        assert_eq!(after["schedules"][0]["completed_at"], Value::Null);
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "actual receipt feedback",
            "",
            Some(ops::text(&op, "id")),
        )
        .await;
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "fresh query after save",
            "现在这两项还有逾期吗？截止分别是什么时候？",
            None,
        )
        .await;
        assert!(report.last().unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "query_records"));
        turn(
            &mut conn,
            &http,
            &key,
            &mut messages,
            &mut report,
            "plan based on workload",
            "根据未来七天的任务、阶段和安排建议哪天休息一天，先只给建议，不创建。",
            None,
        )
        .await;
        assert!(report.last().unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "get_workload"));
        std::fs::create_dir_all("../artifacts/runtime-provider").unwrap();
        std::fs::write(
            "../artifacts/runtime-provider/result.json",
            serde_json::to_string_pretty(&report).unwrap(),
        )
        .unwrap();
    });
}
