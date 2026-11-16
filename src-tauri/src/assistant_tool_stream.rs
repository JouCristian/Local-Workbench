//! Streaming text + fragmented standard tool_calls. Only a complete provider turn
//! can authorize dispatch; an interrupted arguments fragment never executes.
use super::StreamEvent;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::ipc::Channel;

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}
#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
    data: Vec<String>,
    content: String,
    calls: BTreeMap<usize, Call>,
    finish: Option<String>,
}
impl Decoder {
    fn frame(&mut self, events: &Channel<StreamEvent>) -> Result<(), String> {
        if self.data.is_empty() {
            return Ok(());
        }
        let raw = self.data.join("\n");
        self.data.clear();
        if raw.trim() == "[DONE]" {
            return Ok(());
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| "流式数据格式无效")?;
        if value.get("error").is_some() {
            return Err("模型服务返回错误，请重试".into());
        }
        let Some(c) = value["choices"].as_array().and_then(|a| a.first()) else {
            return Ok(());
        };
        let delta = &c["delta"];
        if let Some(t) = delta["content"].as_str() {
            self.content.push_str(t);
            let _ = events.send(StreamEvent::Delta { text: t.into() });
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for tool in calls {
                let index = tool["index"].as_u64().ok_or("工具片段缺少序号")? as usize;
                if index >= 8 {
                    return Err("模型一次请求的工具过多，请拆分需求".into());
                }
                let c = self.calls.entry(index).or_default();
                if let Some(s) = tool["id"].as_str() {
                    c.id.push_str(s);
                }
                if let Some(s) = tool["function"]["name"].as_str() {
                    c.name.push_str(s);
                }
                if let Some(s) = tool["function"]["arguments"].as_str() {
                    c.args.push_str(s);
                }
                if c.args.len() > 300000 || c.name.len() > 100 || c.id.len() > 200 {
                    return Err("工具请求过长".into());
                }
            }
        }
        if self.content.len() > 500000 {
            return Err("回复过长，请拆分需求".into());
        }
        if let Some(reason) = c["finish_reason"].as_str() {
            self.finish = Some(reason.into());
        }
        Ok(())
    }
    fn line(&mut self, line: &[u8], events: &Channel<StreamEvent>) -> Result<(), String> {
        let line = std::str::from_utf8(line)
            .map_err(|_| "流式编码无效")?
            .trim_end_matches('\r')
            .trim_start_matches('\u{feff}');
        if line.is_empty() {
            self.frame(events)?;
        } else if let Some(s) = line.strip_prefix("data:") {
            self.data.push(s.trim_start_matches(' ').into());
        }
        Ok(())
    }
    fn feed(&mut self, bytes: &[u8], events: &Channel<StreamEvent>) -> Result<(), String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() + self.data.iter().map(String::len).sum::<usize>() > 2000000 {
            return Err("服务返回过多数据".into());
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
        }
        Ok(())
    }
    fn done(mut self, events: &Channel<StreamEvent>) -> Result<Value, String> {
        let pending = std::mem::take(&mut self.pending);
        if !pending.is_empty() {
            self.line(&pending, events)?;
        }
        self.frame(events)?;
        let reason = self
            .finish
            .as_deref()
            .ok_or("连接在回复结束前中断，已收到的正文将保留")?;
        if !["stop", "tool_calls"].contains(&reason) {
            return Err(match reason {
                "length" => "本次回复达到长度限制，可从断点继续",
                _ => "模型中止了本次回复，请重试",
            }
            .into());
        }
        let mut calls = vec![];
        let mut ids = std::collections::HashSet::new();
        for (_, call) in self.calls {
            if call.id.is_empty()
                || call.name.is_empty()
                || !ids.insert(call.id.clone())
                || !serde_json::from_str::<Value>(&call.args).is_ok_and(|v| v.is_object())
            {
                return Err("工具参数未完整返回，本次未执行该工具".into());
            }
            calls.push(json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.args}}));
        }
        if reason == "tool_calls" && calls.is_empty() {
            return Err("模型未提供完整的工具调用".into());
        }
        if calls.is_empty() && self.content.trim().is_empty() {
            return Err("模型返回了空回复，请重试".into());
        }
        let mut result = json!({"role":"assistant","content":if self.content.is_empty(){Value::Null}else{json!(self.content)}});
        if !calls.is_empty() {
            result["tool_calls"] = json!(calls);
        }
        Ok(result)
    }
}
pub async fn receive(
    mut response: reqwest::Response,
    events: &Channel<StreamEvent>,
) -> Result<Value, String> {
    let plain = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("application/json"));
    let mut bytes = Vec::new();
    let mut decoder = Decoder::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "连接中断，已收到的正文将保留")?
    {
        if plain {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > 2000000 {
                return Err("回复数据过大".into());
            }
        } else {
            decoder.feed(&chunk, events)?;
            if decoder.finish.is_some() {
                break;
            }
        }
    }
    if plain {
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "服务返回无效数据")?;
        let c = &v["choices"][0];
        let calls = c["message"]["tool_calls"]
            .as_array()
            .map(|a| {
                a.iter()
                    .enumerate()
                    .map(|(i, t)| {
                        let mut t = t.clone();
                        t["index"] = json!(i);
                        t
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        decoder.data.push(json!({"choices":[{"delta":{"content":c["message"]["content"],"tool_calls":calls},"finish_reason":c["finish_reason"]}]}).to_string());
        decoder.frame(events)?;
    }
    decoder.done(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_tool_arguments_and_utf8_are_accumulated() {
        let mut d = Decoder::default();
        let ch = Channel::new(|_| Ok(()));
        for event in [
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"query_records","arguments":"{\"table\":"}}]},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"tasks\"}"}}]},"finish_reason":"tool_calls"}]}),
        ] {
            for b in format!("data: {}\r\n\r\n", event).as_bytes().chunks(1) {
                d.feed(b, &ch).unwrap();
            }
        }
        let m = d.done(&ch).unwrap();
        assert_eq!(
            m["tool_calls"][0]["function"]["arguments"],
            "{\"table\":\"tasks\"}"
        );
    }
    #[test]
    fn truncated_arguments_and_transport_never_dispatch() {
        let ch = Channel::new(|_| Ok(()));
        let mut d = Decoder::default();
        d.data.push(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"prepare_operation","arguments":"{"}}]},"finish_reason":"tool_calls"}]}).to_string());
        assert!(d.done(&ch).is_err());
        let mut d = Decoder::default();
        d.data.push(
            json!({"choices":[{"delta":{"content":"一部分正文"},"finish_reason":null}]})
                .to_string(),
        );
        assert!(d.done(&ch).is_err());
    }
}
