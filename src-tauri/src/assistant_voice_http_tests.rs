use super::*;
use std::io::{Read, Write};

fn server(status: u16, body: &str) -> (String, std::thread::JoinHandle<Vec<u8>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_string();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = vec![];
        let (offset, length) = loop {
            let mut chunk = [0; 8192];
            let n = socket.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                break (end + 4, length);
            }
        };
        while bytes.len() < offset + length {
            let mut chunk = [0; 8192];
            let n = socket.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        write!(socket,"HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        bytes
    });
    (url, thread)
}

#[test]
fn asr_uploads_only_valid_wav_multipart_and_returns_editable_text() {
    tauri::async_runtime::block_on(async {
        let bytes = wav(&vec![2000; 16000]).unwrap();
        let (url, thread) = server(
            200,
            r#"{"text":" 明天下午复习 ","duration_ms":1000,"request_id":"fixture"}"#,
        );
        let result = transcribe(&reqwest::Client::new(), &url, "fixture-key", bytes.clone())
            .await
            .unwrap();
        assert_eq!(result.text, "明天下午复习");
        assert_eq!(result.duration_ms, 1000);
        let request = thread.join().unwrap();
        let text = String::from_utf8_lossy(&request);
        assert!(text.contains("multipart/form-data; boundary="));
        assert!(text.contains("name=\"file\"; filename=\"voice.wav\""));
        assert!(text.contains("audio/wav"));
        assert!(request.windows(bytes.len()).any(|w| w == bytes));
        assert!(
            !text.contains("conversation_id")
                && !text.contains("messages")
                && !text.contains("query_records")
        );
    });
}

#[test]
fn asr_errors_and_empty_results_are_not_retried_or_treated_as_text() {
    tauri::async_runtime::block_on(async {
        for (status, body, expected) in [
            (401, "{}", "API Key"),
            (402, "{}", "余额"),
            (429, "{}", "请求过多"),
            (503, "{}", "暂时不可用"),
            (200, r#"{"text":"   "}"#, "未识别"),
            (200, "bad-json", "响应无效"),
        ] {
            let (url, thread) = server(status, body);
            let error = transcribe(
                &reqwest::Client::new(),
                &url,
                "fixture-key",
                wav(&vec![2000; 8000]).unwrap(),
            )
            .await
            .err()
            .unwrap();
            assert!(error.contains(expected), "{error}");
            thread.join().unwrap(); // server accepts exactly one request: no auto-retry
        }
    });
}

#[test]
#[ignore = "One paid DeepSeek ASR request using an explicitly generated synthetic speech fixture, never the microphone"]
fn actual_deepseek_asr_synthetic_fixture() {
    tauri::async_runtime::block_on(async {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/voice-provider/synthetic.wav");
        let bytes = std::fs::read(file).expect(
            "Generate the documented synthetic fixture first; never substitute personal recordings",
        );
        assert!(bytes.len() < 8 * 1024 * 1024);
        assert_eq!(&bytes[..4], b"RIFF");
        let http = super::super::client().unwrap();
        let key = super::super::secret().expect("Configure DeepSeek; do not log credentials");
        let result = transcribe(&http, "https://api.deepseek.com/v1/tools/asr", &key, bytes)
            .await
            .unwrap();
        std::fs::write(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/voice-provider/result.json"),serde_json::to_string_pretty(&serde_json::json!({"text":result.text,"duration_ms":result.duration_ms,"source":"Windows synthesized speech; no microphone","passed":result.text.contains("明天") && result.text.contains("学习")})).unwrap()).unwrap();
        assert!(
            result.text.contains("明天") && result.text.contains("学习"),
            "Synthetic speech transcript did not match fixture"
        );
        println!(
            "Synthetic ASR fixture passed ({}ms audio); credential never logged",
            result.duration_ms
        );
    });
}
