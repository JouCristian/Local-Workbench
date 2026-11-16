//! Bounded SSE decoding. A normal finish frame is authoritative; a trailing
//! newline or redundant [DONE] trailer is not required to accept a full reply.
use super::StreamEvent;
use serde_json::Value;
use tauri::ipc::Channel;
pub const EMPTY_REPLY: &str = "DeepSeek 返回了空回复，请重试。本次未创建记录";
pub const INVALID_JSON: &str = "回复内容未形成完整 JSON，请重试。本次未创建记录";

#[derive(Default)]
struct Decoder {
    plain_text: bool,
    pending: Vec<u8>,
    data: Vec<String>,
    output: String,
    finished: bool,
}
fn check_reason(reason: Option<&str>) -> Result<bool, String> {
    match reason {
        Some("stop") => Ok(true),
        Some("length") => Err("回复超出长度限制，请减少一次创建的事项。本次未创建记录".into()),
        Some("content_filter") => Err("DeepSeek 未能提供本次回复".into()),
        Some("insufficient_system_resource") => {
            Err("DeepSeek 服务资源不足，本次生成被中止，请稍后重试".into())
        }
        Some("aborted") => Err("DeepSeek 中止了本次回复，请重试。本次未创建记录".into()),
        Some("tool_calls") => Err("服务返回了未支持的工具调用，请重试。本次未创建记录".into()),
        Some(_) => Err("服务返回了无法确认的结束状态，本次未创建记录".into()),
        None => Ok(false),
    }
}
impl Decoder {
    fn event(&mut self, events: &Channel<StreamEvent>) -> Result<(), String> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = self.data.join("\n");
        self.data.clear();
        if data.trim() == "[DONE]" {
            self.finished = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data).map_err(|_| "服务返回了无效的流式数据")?;
        if value.get("error").is_some() {
            return Err("DeepSeek 返回服务错误，请稍后重试".into());
        }
        let Some(choice) = value["choices"].as_array().and_then(|c| c.first()) else {
            return Ok(());
        };
        if let Some(text) = choice["delta"]["content"].as_str() {
            self.output.push_str(text);
            if self.output.len() > 500_000 {
                return Err("回复过长，请拆分需求".into());
            }
            let _ = events.send(StreamEvent::Delta { text: text.into() });
        } else if choice["delta"]["reasoning_content"].is_string() {
            let _ = events.send(StreamEvent::Thinking);
        }
        self.finished |= check_reason(choice["finish_reason"].as_str())?;
        Ok(())
    }
    fn line(&mut self, line: &[u8], events: &Channel<StreamEvent>) -> Result<(), String> {
        let line = std::str::from_utf8(line)
            .map_err(|_| "服务返回了无效编码")?
            .trim_end_matches('\r')
            .trim_start_matches('\u{feff}');
        if line.is_empty() {
            self.event(events)?;
        } else if let Some(data) = line.strip_prefix("data:") {
            self.data
                .push(data.strip_prefix(' ').unwrap_or(data).into());
        }
        Ok(())
    }
    fn feed(&mut self, bytes: &[u8], events: &Channel<StreamEvent>) -> Result<(), String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() + self.data.iter().map(String::len).sum::<usize>() > 2_000_000 {
            return Err("服务返回的数据过大".into());
        }
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n' || *b == b'\r') {
            if self.pending[end] == b'\r' && end + 1 == self.pending.len() {
                break;
            }
            let delimiter =
                if self.pending[end] == b'\r' && self.pending.get(end + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
            let line: Vec<u8> = self.pending.drain(..end + delimiter).collect();
            self.line(&line[..end], events)?;
            if self.finished {
                break;
            }
        }
        Ok(())
    }
    fn finish(mut self, events: &Channel<StreamEvent>) -> Result<String, String> {
        if !self.finished {
            let tail = std::mem::take(&mut self.pending);
            if !tail.is_empty() {
                self.line(&tail, events)?;
            }
            self.event(events)?;
        }
        if self.output.trim().is_empty() {
            return Err(EMPTY_REPLY.into());
        }
        if !self.finished {
            return Err("连接在正常结束前关闭，回复未完整返回。本次未创建记录，请重试".into());
        }
        // Even a finish marker cannot make a truncated JSON object safe to apply.
        if !self.plain_text {
            serde_json::from_str::<Value>(&self.output).map_err(|_| INVALID_JSON)?;
        }
        Ok(self.output)
    }
}
pub async fn receive(
    response: reqwest::Response,
    events: &Channel<StreamEvent>,
) -> Result<String, String> {
    receive_mode(response, events, false).await
}
pub async fn receive_text(
    response: reqwest::Response,
    events: &Channel<StreamEvent>,
) -> Result<String, String> {
    receive_mode(response, events, true).await
}
async fn receive_mode(
    mut response: reqwest::Response,
    events: &Channel<StreamEvent>,
    plain_text: bool,
) -> Result<String, String> {
    let json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.to_ascii_lowercase().contains("application/json"));
    if json {
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "连接中断，本次未创建记录")?
        {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > 2_000_000 {
                return Err("服务返回的数据过大".into());
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "服务返回的 JSON 无效")?;
        if value.get("error").is_some() {
            return Err("DeepSeek 返回服务错误，请稍后重试".into());
        }
        let choice = &value["choices"][0];
        if !check_reason(choice["finish_reason"].as_str())? {
            return Err("服务未确认回复正常结束，本次未创建记录".into());
        }
        let text = choice["message"]["content"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or(EMPTY_REPLY)?;
        if text.len() > 500_000 {
            return Err("回复过长，请拆分需求".into());
        }
        if !plain_text {
            serde_json::from_str::<Value>(text).map_err(|_| INVALID_JSON)?;
        }
        let _ = events.send(StreamEvent::Delta { text: text.into() });
        return Ok(text.into());
    }
    let mut decoder = Decoder {
        plain_text,
        ..Decoder::default()
    };
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "连接中断，本次未保存任何草稿，请重试")?
    {
        decoder.feed(&chunk, events)?;
        if decoder.finished {
            break;
        }
    }
    decoder.finish(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn decode(body: &str) -> Result<String, String> {
        let channel = Channel::new(|_| Ok(()));
        let mut d = Decoder::default();
        for bytes in body.as_bytes().chunks(2) {
            d.feed(bytes, &channel)?;
        }
        d.finish(&channel)
    }
    fn frame(content: &str, finish: Value) -> String {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"delta":{"content":content},"finish_reason":finish}]})
        )
    }
    #[test]
    fn no_newline_done_and_no_done_normal_finish_are_complete() {
        let output = "{\"answer\":\"你好\",\"proposals\":[]}";
        assert_eq!(
            decode(&(frame(output, Value::Null) + "data: [DONE]")).unwrap(),
            output
        );
        let stop = frame("", Value::String("stop".into()));
        assert_eq!(
            decode(&(frame(output, Value::Null) + stop.trim_end())).unwrap(),
            output
        );
    }
    #[test]
    fn valid_json_without_an_end_marker_is_still_incomplete() {
        assert!(decode(&frame("{\"answer\":\"你好\"}", Value::Null)).is_err());
    }
    #[test]
    fn text_mode_accepts_non_json_prose_but_still_rejects_missing_finish() {
        let channel = Channel::new(|_| Ok(()));
        let text = "他说：\"你好\"\n正文可以包含未闭合的 {";
        let mut d = Decoder {
            plain_text: true,
            ..Decoder::default()
        };
        d.feed(
            frame(text, Value::String("stop".into())).as_bytes(),
            &channel,
        )
        .unwrap();
        assert_eq!(d.finish(&channel).unwrap(), text);
        let mut d = Decoder {
            plain_text: true,
            ..Decoder::default()
        };
        d.feed(frame(text, Value::Null).as_bytes(), &channel)
            .unwrap();
        assert_eq!(d.output, text);
        assert!(d.finish(&channel).is_err());
    }
    #[test]
    fn rejection_reasons_and_empty_or_truncated_content_are_not_success() {
        for reason in [
            "length",
            "aborted",
            "insufficient_system_resource",
            "content_filter",
            "tool_calls",
        ] {
            assert!(decode(&frame("{}", Value::String(reason.into()))).is_err());
        }
        assert!(decode(&frame("", Value::String("stop".into())))
            .unwrap_err()
            .contains("空回复"));
        assert!(decode(&frame("{\"answer\":", Value::String("stop".into()))).is_err());
    }
    #[test]
    fn split_utf8_comments_and_multiline_event_fields_work() {
        let body=": keep-alive\r\n\r\nevent: message\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"{\\\"answer\\\":\\\"中文😀\\\"}\"},\r\ndata: \"finish_reason\":\"stop\"}]}\r\n\r\n";
        assert_eq!(decode(body).unwrap(), "{\"answer\":\"中文😀\"}");
        assert_eq!(
            decode(&body.replace("\r\n", "\r")).unwrap(),
            "{\"answer\":\"中文😀\"}"
        );
    }
    #[test]
    fn actual_http_json_response_from_a_buffering_gateway_is_supported() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let output = "{\"answer\":\"你好\",\"proposals\":[]}";
        let body =
            serde_json::json!({"choices":[{"message":{"content":output},"finish_reason":"stop"}]})
                .to_string();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer);
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        tauri::async_runtime::block_on(async {
            let response = reqwest::Client::new()
                .get(format!("http://{address}"))
                .send()
                .await
                .unwrap();
            assert_eq!(
                receive(response, &Channel::new(|_| Ok(()))).await.unwrap(),
                output
            );
        });
        handle.join().unwrap();
    }
}
