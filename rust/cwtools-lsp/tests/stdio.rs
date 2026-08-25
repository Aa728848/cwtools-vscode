use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

fn frame(payload: &str) -> Vec<u8> {
    let bytes = payload.as_bytes();
    let mut framed = format!("Content-Length: {}\r\n\r\n", bytes.len()).into_bytes();
    framed.extend_from_slice(bytes);
    framed
}

fn frames(bytes: &[u8]) -> Vec<Value> {
    let mut cursor = 0;
    let mut messages = Vec::new();
    while cursor < bytes.len() {
        let Some(header_end) = bytes[cursor..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        else {
            break;
        };
        let header_end = cursor + header_end;
        let header = std::str::from_utf8(&bytes[cursor..header_end]).expect("UTF-8 headers");
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .expect("content length")
            .parse()
            .expect("numeric length");
        let payload_start = header_end + 4;
        let payload_end = payload_start + length;
        assert!(payload_end <= bytes.len(), "complete payload");
        messages.push(
            serde_json::from_slice(&bytes[payload_start..payload_end]).expect("JSON-RPC payload"),
        );
        cursor = payload_end;
    }
    messages
}

struct FrameFeed {
    buffer: Vec<u8>,
    parsed: usize,
}

impl FrameFeed {
    fn new() -> Self {
        Self {
            buffer: Vec::new(),
            parsed: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();
        let mut cursor = self.parsed;
        while cursor < self.buffer.len() {
            let Some(header_end) = self.buffer[cursor..]
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            else {
                break;
            };
            let header_end = cursor + header_end;
            let header =
                std::str::from_utf8(&self.buffer[cursor..header_end]).expect("UTF-8 headers");
            let length: usize = header
                .strip_prefix("Content-Length: ")
                .expect("content length")
                .parse()
                .expect("numeric length");
            let payload_start = header_end + 4;
            let payload_end = payload_start + length;
            if payload_end > self.buffer.len() {
                break;
            }
            messages.push(
                serde_json::from_slice(&self.buffer[payload_start..payload_end])
                    .expect("JSON-RPC payload"),
            );
            cursor = payload_end;
        }
        self.parsed = cursor;
        messages
    }
}

#[test]
fn stdio_background_build_completes_while_client_is_idle() {
    let input = [
        frame(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///black-box"}}"#),
        frame(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#),
    ]
    .concat();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cwtools-lsp"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("standalone language server");
    let mut stdin = child.stdin.take().expect("stdin");
    stdin.write_all(&input).expect("request frames");
    let stdout = child.stdout.take().expect("stdout");
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut feed = FrameFeed::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            for message in feed.push(&chunk[..read]) {
                if sender.send(message).is_err() {
                    return;
                }
            }
        }
    });
    // The client sends nothing after `initialized`; the server must still drive
    // the background build, stream progress, and reach the completion bar.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "background build did not complete while the client was idle"
        );
        let message = match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
            Ok(message) => message,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("server closed its output before completing the build")
            }
        };
        if message["method"] == "loadingBar"
            && message["params"]["enable"] == false
            && message["params"]["percentage"] == 100
        {
            break;
        }
    }
    let shutdown = frame(r#"{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}"#);
    let exit = frame(r#"{"jsonrpc":"2.0","method":"exit","params":null}"#);
    stdin
        .write_all(&[shutdown, exit].concat())
        .expect("exit frames");
    drop(stdin);
    let exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if child.try_wait().expect("wait").is_some() {
            break;
        }
        assert!(
            std::time::Instant::now() < exit_deadline,
            "server did not exit after shutdown"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(child.wait().expect("server exit").success());
}

#[test]
fn stdio_process_completes_manifest_lifecycle_without_proxy() {
    let input = [
        frame(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///black-box"}}"#),
        frame(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#),
        frame(r#"{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}"#),
        frame(r#"{"jsonrpc":"2.0","method":"exit","params":null}"#),
    ]
    .concat();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cwtools-lsp"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("standalone language server");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&input)
        .expect("request frames");
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut output)
        .expect("response frames");
    assert!(child.wait().expect("server exit").success());

    let messages = frames(&output);
    assert!(messages.len() >= 6);
    assert_eq!(messages[0]["id"], 1);
    assert!(
        messages[0]["result"]["capabilities"]["hoverProvider"]
            .as_bool()
            .unwrap_or(false)
    );
    assert!(
        messages[0]["result"]["capabilities"]["executeCommandProvider"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command == "cacheVanilla")
    );
    assert_eq!(messages[1]["method"], "window/logMessage");
    assert_eq!(messages[2]["method"], "loadingBar");
    assert_eq!(messages[3]["method"], "debugBar");
    assert_eq!(messages[4]["method"], "cwtools/serverReady");
    // Readiness must be emitted before any potentially expensive semantic build.
    assert!(
        messages[..=4]
            .iter()
            .all(|message| message["method"] != "cwtools/validationComplete")
    );
    let shutdown = messages
        .iter()
        .find(|message| message["id"] == 2)
        .expect("shutdown response");
    assert_eq!(shutdown["result"], Value::Null);
}
