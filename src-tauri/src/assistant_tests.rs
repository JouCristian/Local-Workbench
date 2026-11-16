use super::*;
#[test]
fn conversation_preferences_migration_preserves_old_history() {
    tauri::async_runtime::block_on(async {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/007_assistant.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO assistant_conversations VALUES ('old','original','created','updated')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/009_conversation_preferences.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        let row = sqlx::query("SELECT * FROM assistant_conversations WHERE id='old'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("title"), "original");
        assert_eq!(row.get::<i64, _>("title_manual"), 0);
        assert!(row.get::<Option<String>, _>("pinned_at").is_none());
    });
}
async fn database() -> SqliteConnection {
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true),
    )
    .await
    .unwrap();
    for migration in [
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
    ] {
        sqlx::raw_sql(migration).execute(&mut conn).await.unwrap();
    }
    sqlx::query("INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES ('conversation','test','now','now')")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO assistant_messages(id,conversation_id,role,text,draft_state,created_at) VALUES ('message','conversation','assistant','test','pending','now')").execute(&mut conn).await.unwrap();
    conn
}
fn task() -> Insert {
    Insert {
        table: "tasks".into(),
        record: json!({"id":uuid::Uuid::new_v4().to_string(),"title":"Test","notes":"","status":"todo","priority":"medium","due_date":null,"due_time":null,"project_id":null,"stage_id":null,"archived_at":null,"created_at":"2026-11-15T10:00:00Z","updated_at":"2026-11-15T10:00:00Z"}),
    }
}
fn schedule(id: &str, date: &str) -> Insert {
    Insert {
        table: "schedules".into(),
        record: json!({"id":uuid::Uuid::new_v4().to_string(),"title":"Plan","notes":"","task_id":id,"date":date,"period":"morning","start_time":null,"end_time":null,"created_at":"2026-11-15T10:00:00Z","updated_at":"2026-11-15T10:00:00Z"}),
    }
}
#[test]
fn confirmation_is_atomic_idempotent_and_preserves_fuzzy_time() {
    tauri::async_runtime::block_on(async {
        let mut conn = database().await;
        let t = task();
        let id = string(&t.record, "id").to_string();
        let inserts = vec![schedule(&id, "2026-11-16"), t, schedule(&id, "2026-11-17")];
        assert_eq!(apply(&mut conn, "message", &inserts).await.unwrap(), 3);
        assert_eq!(apply(&mut conn, "message", &inserts).await.unwrap(), 0);
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM schedules WHERE task_id=? AND start_time IS NULL AND end_time IS NULL").bind(&id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(count, 2);
        let state: String =
            sqlx::query_scalar("SELECT draft_state FROM assistant_messages WHERE id='message'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(state, "applied");
    });
}
#[test]
fn stale_form_confirmation_cannot_create_records() {
    tauri::async_runtime::block_on(async {
        let mut conn = database().await;
        assert!(apply_revision(&mut conn, "message", &[task()], Some(1))
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            apply_revision(&mut conn, "message", &[task()], Some(0))
                .await
                .unwrap(),
            1
        );
    });
}
#[test]
fn invalid_or_duplicate_group_rolls_back_every_record() {
    tauri::async_runtime::block_on(async {
        for invalid_date in ["2026-02-30", "2026-11-16"] {
            let mut conn = database().await;
            let t = task();
            let id = string(&t.record, "id").to_string();
            let mut bad = schedule(&id, invalid_date);
            if invalid_date == "2026-11-16" {
                bad.record["start_time"] = json!("09:00");
            }
            assert!(apply(&mut conn, "message", &[t, bad]).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(count, 0);
            let state: String =
                sqlx::query_scalar("SELECT draft_state FROM assistant_messages WHERE id='message'")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(state, "pending");
        }
        let mut conn = database().await;
        let one = task();
        let mut two = task();
        two.record["title"] = json!("Ｔ e s t");
        assert!(apply(&mut conn, "message", &[one, two]).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 0);
    });
}
#[test]
fn cancelled_draft_and_arbitrary_tables_cannot_write() {
    tauri::async_runtime::block_on(async {
        let mut conn = database().await;
        let mut invalid = task();
        invalid.table = "settings".into();
        assert!(apply(&mut conn, "message", &[invalid]).await.is_err());
        sqlx::query("UPDATE assistant_messages SET draft_state='cancelled'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(apply(&mut conn, "message", &[task()]).await.is_err());
    });
}
#[test]
fn actual_http_sse_handles_split_utf8_and_rejects_truncation() {
    use std::io::Write;
    for done in [true, false] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let output = "{\"answer\":\"明天上午\",\"proposals\":[]}";
        let mut body = format!(
            "data: {}\r\n\r\n",
            json!({"choices":[{"delta":{"content":output}}]})
        );
        if done {
            body.push_str("data: [DONE]\n\n");
        }
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer);
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            for bytes in body.as_bytes().chunks(2) {
                socket.write_all(bytes).unwrap();
                socket.flush().unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            let response = client()
                .unwrap()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            let channel = Channel::new(|_| Ok(()));
            let result = receive_completion(response, &channel).await;
            if done {
                assert_eq!(result.unwrap(), output);
            } else {
                assert!(result.is_err());
            }
        });
        handle.join().unwrap();
    }
}

#[test]
fn empty_completion_retries_once_as_json_and_keeps_the_conversation() {
    use std::io::Write;
    for recover in [true, false] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let output = "{\"answer\":\"第二轮也正常回答。\",\"proposals\":[]}";
        let handle = std::thread::spawn(move || {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let (header_end, length) = loop {
                    let mut buffer = [0; 4096];
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
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
                while bytes.len() < header_end + length {
                    let mut buffer = [0; 4096];
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let request: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                assert_eq!(request["stream"], json!(attempt == 0));
                assert_eq!(request["messages"][0]["content"], "继续这段小说");
                let (content_type, body) = if attempt == 0 {
                    (
                        "text/event-stream",
                        format!(
                            "data: {}\n\n",
                            json!({"choices":[{"delta":{"content":""},"finish_reason":"stop"}]})
                        ),
                    )
                } else {
                    assert!(request["messages"].as_array().unwrap().len() > 1);
                    ("application/json",json!({"choices":[{"message":{"content":if recover{output}else{""}},"finish_reason":"stop"}]}).to_string())
                };
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        tauri::async_runtime::block_on(async {
            let result = request_completion(
                &client().unwrap(),
                &format!("http://{address}"),
                "test-key",
                "deepseek-flash",
                vec![json!({"role":"user","content":"继续这段小说"})],
                &Channel::new(|_| Ok(())),
            )
            .await;
            if recover {
                assert_eq!(result.unwrap(), output);
            } else {
                assert_eq!(result.unwrap_err(), stream::EMPTY_REPLY);
            }
        });
        handle.join().unwrap();
    }
}
