//! Click-to-record audio lives in memory only. No business writes or model tools.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};
use tokio::sync::{oneshot, watch};

const RATE: u32 = 16_000;
const MAX_SECONDS: usize = 120;
const MAX_SAMPLES: usize = RATE as usize * MAX_SECONDS;
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub struct VoiceState(Mutex<Option<Session>>);
struct Session {
    id: String,
    stop: mpsc::Sender<bool>,
    audio: Option<oneshot::Receiver<Result<Vec<u8>>>>,
    cancel: watch::Sender<bool>,
}
impl Drop for VoiceState {
    fn drop(&mut self) {
        if let Ok(Some(s)) = self.0.get_mut().map(Option::take) {
            let _ = s.cancel.send(true);
            let _ = s.stop.send(false);
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceEvent {
    Level { level: f32, elapsed_ms: u64 },
    Limit,
    Error { message: String },
}
#[derive(Serialize)]
pub struct Transcript {
    text: String,
    duration_ms: u64,
}

// Weighted sample averaging keeps fractional source rates (e.g. 44.1kHz)
// continuous across callbacks, and bounds memory to 120s of mono 16-bit PCM.
struct Capture {
    samples: Vec<i16>,
    source_rate: u32,
    phase: u32,
    area: f64,
    peak: f32,
    failure: bool,
}
impl Capture {
    fn new(source_rate: u32) -> Self {
        Self {
            samples: Vec::with_capacity(MAX_SAMPLES),
            source_rate,
            phase: 0,
            area: 0.,
            peak: 0.,
            failure: false,
        }
    }
    fn push(&mut self, value: f32) {
        let value = if value.is_finite() {
            value.clamp(-1., 1.)
        } else {
            0.
        };
        self.peak = self.peak.max(value.abs());
        let mut remaining = RATE;
        while remaining > 0 && self.samples.len() < MAX_SAMPLES {
            let weight = remaining.min(self.source_rate - self.phase);
            self.area += f64::from(value) * f64::from(weight);
            self.phase += weight;
            remaining -= weight;
            if self.phase == self.source_rate {
                self.samples
                    .push((self.area / f64::from(self.source_rate) * 32767.).round() as i16);
                self.phase = 0;
                self.area = 0.;
            }
        }
    }
}
fn wav(samples: &[i16]) -> Result<Vec<u8>> {
    if samples.len() < RATE as usize / 4 {
        return Err("录音太短，请说完后再停止".into());
    }
    if samples.len() > MAX_SAMPLES {
        return Err("录音超过两分钟，请分段输入".into());
    }
    if samples.iter().all(|v| v.unsigned_abs() < 4) {
        return Err("没有检测到有效声音，请检查麦克风后重试".into());
    }
    let size = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(size as usize + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + size).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&size.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(out)
}
fn input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    data: Arc<Mutex<Capture>>,
) -> Result<cpal::Stream>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let errors = data.clone();
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                if let Ok(mut buffer) = data.lock() {
                    for frame in input.chunks_exact(channels) {
                        let mono = frame
                            .iter()
                            .map(|s| <f32 as cpal::FromSample<T>>::from_sample_(*s))
                            .sum::<f32>()
                            / channels as f32;
                        buffer.push(mono);
                    }
                }
            },
            move |_| {
                if let Ok(mut b) = errors.lock() {
                    b.failure = true;
                }
            },
            None,
        )
        .map_err(|_| "无法打开麦克风，请检查 Windows 麦克风权限、设备连接及占用情况".into())
}
fn capture(
    stop: mpsc::Receiver<bool>,
    events: Channel<VoiceEvent>,
    ready: oneshot::Sender<Result<()>>,
) -> Result<Vec<u8>> {
    let setup = || {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("没有找到麦克风，请连接设备后重试")?;
        let supported = device
            .default_input_config()
            .map_err(|_| "无法读取麦克风配置，请检查系统权限")?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        if config.channels == 0 || !(8_000..=192_000).contains(&config.sample_rate.0) {
            return Err("当前麦克风格式不受支持，请调整 Windows 录音格式".to_string());
        }
        let data = Arc::new(Mutex::new(Capture::new(config.sample_rate.0)));
        let stream = match format {
            cpal::SampleFormat::F32 => input_stream::<f32>(&device, &config, data.clone()),
            cpal::SampleFormat::I16 => input_stream::<i16>(&device, &config, data.clone()),
            cpal::SampleFormat::U16 => input_stream::<u16>(&device, &config, data.clone()),
            cpal::SampleFormat::I32 => input_stream::<i32>(&device, &config, data.clone()),
            _ => Err("当前麦克风采样格式不受支持，请选择16位或浮点录音格式".into()),
        }?;
        stream
            .play()
            .map_err(|_| "无法启动麦克风，请检查设备权限".to_string())?;
        Ok((stream, data))
    };
    let (stream, data) = match setup() {
        Ok(s) => {
            let _ = ready.send(Ok(()));
            s
        }
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let began = Instant::now();
    let mut limited = false;
    let result = loop {
        match stop.recv_timeout(Duration::from_millis(50)) {
            Ok(true) => break Ok(()),
            Ok(false) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err("已取消语音输入".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        let mut b = data.lock().map_err(|_| "录音缓冲不可用")?;
        if b.failure {
            break Err("麦克风连接中断，请检查设备后重新录音".into());
        }
        if b.samples.len() >= MAX_SAMPLES || began.elapsed().as_secs() >= MAX_SECONDS as u64 {
            limited = true;
            break Ok(());
        }
        let level = (b.peak * 3.).sqrt().clamp(0., 1.);
        b.peak = 0.;
        if events
            .send(VoiceEvent::Level {
                level,
                elapsed_ms: began.elapsed().as_millis() as u64,
            })
            .is_err()
        {
            break Err("语音页面已关闭".into());
        }
    };
    drop(stream); // release the microphone before encoding/uploading
    result?;
    let bytes = wav(&data.lock().map_err(|_| "录音缓冲不可用")?.samples);
    if limited {
        let _ = events.send(VoiceEvent::Limit);
    }
    bytes
}

#[tauri::command]
pub async fn assistant_voice_start(
    id: String,
    events: Channel<VoiceEvent>,
    state: State<'_, VoiceState>,
) -> Result<()> {
    uuid::Uuid::parse_str(&id).map_err(|_| "语音会话标识无效")?;
    super::secret()?; // validate configuration without exposing credentials
    let (stop, rx) = mpsc::channel();
    let (audio_tx, audio) = oneshot::channel();
    let (ready_tx, ready) = oneshot::channel();
    let (cancel, _) = watch::channel(false);
    {
        let mut current = state.0.lock().map_err(|_| "语音服务忙，请重试")?;
        if current.is_some() {
            return Err("已有录音或识别正在进行，请先结束或取消".into());
        }
        *current = Some(Session {
            id: id.clone(),
            stop,
            audio: Some(audio),
            cancel,
        });
    }
    std::thread::spawn(move || {
        let result = capture(rx, events.clone(), ready_tx);
        if let Err(ref e) = result {
            let _ = events.send(VoiceEvent::Error { message: e.clone() });
        }
        let _ = audio_tx.send(result);
    });
    let result = tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .map_err(|_| "打开麦克风超时，请检查设备权限后重试".to_string())
        .and_then(|r| r.map_err(|_| "录音设备初始化失败".to_string()))
        .and_then(|r| r);
    if result.is_err() {
        clear(&state, &id);
    }
    result
}
fn clear(state: &VoiceState, id: &str) {
    if let Ok(mut current) = state.0.lock() {
        if current.as_ref().is_some_and(|s| s.id == id) {
            if let Some(s) = current.take() {
                let _ = s.stop.send(false);
                let _ = s.cancel.send(true);
            }
        }
    }
}
#[tauri::command]
pub fn assistant_voice_cancel(id: String, state: State<'_, VoiceState>) {
    clear(&state, &id);
}

async fn transcribe(
    http: &reqwest::Client,
    url: &str,
    key: &str,
    bytes: Vec<u8>,
) -> Result<Transcript> {
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes)
            .file_name("voice.wav")
            .mime_str("audio/wav")
            .map_err(|_| "录音格式错误")?,
    );
    let response = http
        .post(url)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| "语音识别连接失败或超时，请检查网络后重新录音")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            400 | 413 | 422 => "语音格式或长度未被接受，请重新录音（最多两分钟）",
            401 | 403 => "语音识别无访问权限，请检查 DeepSeek API Key",
            402 => "DeepSeek 余额不足，无法识别语音",
            429 => "语音识别请求过多，请稍后重试",
            _ => "语音识别服务暂时不可用，请稍后重新录音",
        }
        .into());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "语音识别响应无效，请重试")?;
    let text = value["text"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return Err("未识别到文字，请靠近麦克风重新录音".into());
    }
    if text.chars().count() > 12_000 {
        return Err("识别文字过长，请分段录音".into());
    }
    Ok(Transcript {
        text: text.into(),
        duration_ms: value["duration_ms"].as_u64().unwrap_or(0),
    })
}
#[tauri::command]
pub async fn assistant_voice_finish(
    id: String,
    state: State<'_, VoiceState>,
) -> Result<Transcript> {
    let (audio, mut cancel) = {
        let mut current = state.0.lock().map_err(|_| "语音服务忙")?;
        let s = current
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or("录音已取消或过期")?;
        let audio = s.audio.take().ok_or("这段录音已经在识别，请勿重复提交")?;
        let _ = s.stop.send(true);
        (audio, s.cancel.subscribe())
    };
    let work = async {
        let bytes = audio.await.map_err(|_| "录音已结束，请重新录音")??;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法建立语音识别连接")?;
        transcribe(
            &http,
            "https://api.deepseek.com/v1/tools/asr",
            &super::secret()?,
            bytes,
        )
        .await
    };
    let result =
        tokio::select! { result=work=>result, _=cancel.changed()=>Err("已取消语音输入".into()) };
    clear(&state, &id);
    result
}

#[cfg(test)]
#[path = "assistant_voice_http_tests.rs"]
mod http_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampling_preserves_fractional_phase_and_is_bounded() {
        for rate in [8000, 16000, 44100, 48000] {
            let mut b = Capture::new(rate);
            for _ in 0..rate {
                b.push(0.25);
            }
            assert_eq!(b.samples.len(), RATE as usize);
            assert!(b.samples.iter().all(|v| (*v - 8192).abs() <= 1));
            assert_eq!(b.phase, 0);
        }
        let mut b = Capture::new(RATE);
        b.samples.resize(MAX_SAMPLES, 1);
        b.push(f32::NAN);
        assert_eq!(b.samples.len(), MAX_SAMPLES);
    }
    #[test]
    fn wav_is_mono_pcm16_with_valid_lengths_and_rejects_silence() {
        assert!(wav(&[1; 10]).is_err());
        assert!(wav(&vec![0; 8000]).is_err());
        let out = wav(&vec![2000; 16000]).unwrap();
        assert_eq!(&out[..4], b"RIFF");
        assert_eq!(&out[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(out[24..28].try_into().unwrap()), 16000);
        assert_eq!(u32::from_le_bytes(out[40..44].try_into().unwrap()), 32000);
        assert_eq!(out.len(), 32044);
    }
    #[test]
    fn cancelling_an_old_session_cannot_cancel_a_new_one() {
        let state = VoiceState::default();
        let (stop, _) = mpsc::channel();
        let (cancel, mut cancelled) = watch::channel(false);
        *state.0.lock().unwrap() = Some(Session {
            id: "new".into(),
            stop,
            audio: None,
            cancel,
        });
        clear(&state, "old");
        assert!(state.0.lock().unwrap().is_some());
        assert!(!*cancelled.borrow_and_update());
        clear(&state, "new");
        assert!(*cancelled.borrow_and_update());
    }
}
